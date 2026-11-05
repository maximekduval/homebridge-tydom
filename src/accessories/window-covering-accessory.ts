import { getTydomDataPropValue } from "../api/types.js";
import type { Service } from "homebridge";
import type { TydomUpdateType } from "../api/types.js";
import type { TydomDeviceShutterData } from "../typings/tydom.js";
import {
  debug,
  debugGet,
  debugGetResult,
  debugSet,
  debugSetResult,
  debugSetUpdate,
  debugTydomPut,
} from "../platform/trace.js";
import { asNumber } from "../util/basic.js";
import { WriteCoalescer } from "../util/coalesce.js";
import { EchoSuppressor } from "../util/echo.js";
import { styleJson, styleKeyword, styleNumber, styleString } from "../util/style.js";
import { BaseAccessory } from "./base-accessory.js";
import type { AccessoryDeps } from "./base.js";

/** Matches the debounce window the released implementation used. */
const WRITE_DELAY_MS = 250;

/**
 * How long a write counts as a repeat of the one just sent.
 *
 * HomeKit sends the slider's value at every tick of a drag, about once a
 * second, and keeps sending it while the finger rests at an end stop. The
 * gateway has nothing to do for the second one, and answers it with nothing.
 */
const REPEAT_WINDOW_MS = 3_000;

/**
 * What a shutter needs per percent of stroke, rounded up from what a debug
 * trace showed (0.24 to 0.30 s on a Delta Dore roller shutter, slower going up).
 */
export const TRAVEL_MS_PER_PERCENT = 350;

/** Slack on top of the travel: the relay's round trip, the motor starting, a late report. */
export const TRAVEL_MARGIN_MS = 5_000;

/** Why the position the user asked for stopped being held. */
type ReleaseReason = "arrived" | "expired" | "stopped";

/** A roller shutter or awning. */
export class WindowCoveringAccessory extends BaseAccessory {
  readonly #service: Service;
  readonly #writer: WriteCoalescer<number>;
  readonly #echo = new EchoSuppressor();

  /**
   * The position the user asked for, held while the shutter is on its way.
   *
   * The gateway acknowledges a write by reporting the target as the position,
   * then reports where the shutter really is once or twice during the travel.
   * Those reports look exactly like a change made at the wall switch, and
   * treating them as a new target sent the slider back to wherever the shutter
   * was a few seconds in, where it stayed until the shutter arrived.
   *
   * It is released when the shutter reports having reached it, on a stop, or
   * after the estimated travel time. The last one matters: a gateway whose last
   * word was already the target reports nothing at all on arrival.
   */
  #pinned: { value: number; timer: NodeJS.Timeout } | undefined;
  /**
   * Where the shutter is believed to be at rest, which the travel time of the
   * next order is estimated from. Fed by real reports only, never by the
   * acknowledgement of our own write.
   */
  #resting: number | undefined;
  /** The last position sent and when, so a repeat of it can be dropped. */
  #lastSent: { value: number; at: number } | undefined;
  /** HomeKit's `PositionState`; unset means stopped. */
  #travel: number | undefined;

  constructor(deps: AccessoryDeps) {
    super(deps);
    const { CurrentPosition, TargetPosition, PositionState, HoldPosition } =
      this.platform.Characteristic;
    this.#service = this.service(this.platform.Service.WindowCovering);

    this.#writer = new WriteCoalescer<number>({
      delayMs: WRITE_DELAY_MS,
      // Trailing only, matching the released behaviour. A leading write would
      // start the shutter travelling to wherever the finger first landed and
      // then redirect it 250 ms later — a visible stutter on hardware that
      // physically moves, which is the thing this class exists to avoid. The
      // quarter second before a tap takes effect is the price, and the released
      // version has always paid it.
      send: async (position) => {
        const last = this.#lastSent;
        if (last && last.value === position && Date.now() - last.at < REPEAT_WINDOW_MS) {
          debug(
            `Skipping a repeat of the ${styleString("position")} write ${styleNumber(position)}`,
          );
          return;
        }
        debugTydomPut("position", this.accessory, position);
        this.#echo.expect("position", position);
        await this.api.putDeviceData(this.deviceId, this.endpointId, [
          { name: "position", value: position },
        ]);
        this.#lastSent = { value: position, at: Date.now() };
      },
      onError: (error) => {
        this.platform.log.error(`Failed to set position on ${this.name}: ${String(error)}`);
      },
    });

    this.#service.getCharacteristic(PositionState).onGet(
      this.guardRead(() => {
        debugGet(PositionState, this.#service);
        // The gateway does not report travel direction, only a position, so
        // this is worked out from the order given.
        const nextValue = this.#travel ?? PositionState.STOPPED;
        debugGetResult(PositionState, this.#service, nextValue);
        return nextValue;
      }),
    );

    this.#service.getCharacteristic(HoldPosition).onSet(
      this.guardWrite(async (value) => {
        debugSet(HoldPosition, this.#service, value);
        if (!value) {
          return;
        }
        // Stop overrides anything buffered — the user wants it to halt now, not
        // to finish travelling to a position they have abandoned.
        this.#writer.dispose();
        this.#release("stopped");
        // Asking for the position it was heading to is then a new order.
        this.#lastSent = undefined;
        debugTydomPut("positionCmd", this.accessory, "STOP");
        await this.api.putDeviceData(this.deviceId, this.endpointId, [
          { name: "positionCmd", value: "STOP" },
        ]);
        debugSetResult(HoldPosition, this.#service, value, "STOP");
      }),
    );

    this.#service.getCharacteristic(CurrentPosition).onGet(
      this.guardRead(async () => {
        debugGet(CurrentPosition, this.#service);
        const nextValue = await this.#readPosition();
        debugGetResult(CurrentPosition, this.#service, nextValue);
        return nextValue;
      }),
    );

    this.#service
      .getCharacteristic(TargetPosition)
      .onGet(
        this.guardRead(async () => {
          debugGet(TargetPosition, this.#service);
          // While the shutter travels the answer is what was asked for, not the
          // position it has reached: a read made mid-travel (the Home app does
          // one whenever it is opened) would otherwise move the slider back.
          const nextValue = this.#pinned?.value ?? (await this.#readPosition());
          debugGetResult(TargetPosition, this.#service, nextValue);
          return nextValue;
        }),
      )
      .onSet(
        this.guardWrite((value) => {
          debugSet(TargetPosition, this.#service, value);
          const target = value as number;
          this.#pin(target);
          this.#writer.submit(target);
          debugSetResult(TargetPosition, this.#service, value);
        }),
      );
  }

  protected override apply(updates: Record<string, unknown>[], type: TydomUpdateType): void {
    const { CurrentPosition, TargetPosition, ObstructionDetected } = this.platform.Characteristic;

    if (type === "cdata") {
      for (const update of updates) {
        const { event } = update as { event?: unknown };
        debug(`New ${styleKeyword("WindowCovering")} event=${styleJson(event)}`);
      }
      return;
    }

    for (const { name, value } of updates) {
      switch (name) {
        case "position": {
          if (value === null || value === undefined) {
            debug(`Encountered a ${styleString("position")} update with a null value!`);
            break;
          }
          const position = asNumber(value);
          const isEcho = this.#echo.consume("position", position);
          // CurrentPosition tracks what the gateway reports, our own writes
          // included. The acknowledgement of a write is the target rather than
          // where the shutter is, so it is shown early; the next real report
          // corrects it.
          debugSetUpdate(CurrentPosition, this.#service, position);
          this.#service.updateCharacteristic(CurrentPosition, position);
          if (!isEcho) {
            this.#resting = position;
          }
          const pinned = this.#pinned;
          if (pinned) {
            if (isEcho || position !== pinned.value) {
              debug(
                `Keeping ${styleKeyword("TargetPosition")} at the requested ${styleNumber(
                  pinned.value,
                )}, the shutter reports ${styleNumber(position)} on its way`,
              );
              break;
            }
            this.#release("arrived");
          } else if (isEcho) {
            // TargetPosition must not follow the echo of a write, or it fights
            // the next drag the user makes.
            debug(`Ignoring the echo of our own ${styleString("position")} write`);
            break;
          }
          debugSetUpdate(TargetPosition, this.#service, position);
          this.#service.updateCharacteristic(TargetPosition, position);
          break;
        }
        case "obstacleDefect": {
          debugSetUpdate(ObstructionDetected, this.#service, value);
          this.#service.updateCharacteristic(ObstructionDetected, value as boolean);
          break;
        }
        default:
          break;
      }
    }
  }

  override dispose(): void {
    this.#writer.dispose();
    this.#echo.dispose();
    this.clearTimer(this.#pinned?.timer);
    this.#pinned = undefined;
    super.dispose();
  }

  /** Hold the position the user just asked for until the shutter has had time to reach it. */
  #pin(target: number): void {
    const { PositionState } = this.platform.Characteristic;
    this.clearTimer(this.#pinned?.timer);
    const from = this.#resting;
    // Unknown means the whole stroke, which only makes the hold longer.
    const distance = from === undefined ? 100 : Math.abs(target - from);
    const travelMs = distance * TRAVEL_MS_PER_PERCENT + TRAVEL_MARGIN_MS;
    this.#pinned = {
      value: target,
      timer: this.setTimer(() => this.#release("expired"), travelMs),
    };
    if (from === undefined || target === from) {
      this.#setTravel(PositionState.STOPPED);
    } else {
      this.#setTravel(target > from ? PositionState.INCREASING : PositionState.DECREASING);
    }
  }

  #release(reason: ReleaseReason): void {
    const pinned = this.#pinned;
    if (!pinned) {
      return;
    }
    this.clearTimer(pinned.timer);
    this.#pinned = undefined;
    if (reason === "expired") {
      // Nothing is reported on arrival when the gateway's last word was already
      // the target, so after the estimated travel the shutter is taken to rest there.
      this.#resting = pinned.value;
    } else if (reason === "stopped") {
      // Only the gateway knows where it stopped, and it says so.
      this.#resting = undefined;
    }
    this.#setTravel(this.platform.Characteristic.PositionState.STOPPED);
    debug(`Released the requested position ${styleNumber(pinned.value)} (${reason})`);
  }

  #setTravel(state: number): void {
    this.#travel = state;
    this.#service.updateCharacteristic(this.platform.Characteristic.PositionState, state);
  }

  async #readPosition(): Promise<number> {
    const data = await this.read<TydomDeviceShutterData>();
    const position = asNumber(getTydomDataPropValue<number>(data, "position") || 0);
    if (!this.#pinned) {
      this.#resting ??= position;
    }
    return position;
  }
}

export const createWindowCoveringAccessory = (deps: AccessoryDeps): WindowCoveringAccessory =>
  new WindowCoveringAccessory(deps);
