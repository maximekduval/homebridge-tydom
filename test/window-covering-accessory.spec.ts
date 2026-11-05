import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TRAVEL_MARGIN_MS,
  TRAVEL_MS_PER_PERCENT,
  WindowCoveringAccessory,
} from "../src/accessories/window-covering-accessory.js";
import { createAccessoryHarness } from "./accessory-harness.js";

/** HomeKit's slider writes about once a second; the coalescer waits 250 ms. */
const DEBOUNCE_MS = 250;

/**
 * A shutter resting at `resting`, as the gateway reported it at start-up.
 *
 * The first report is pushed rather than read so the accessory knows where the
 * shutter is, which is what it estimates a travel time from.
 */
const mount = (resting = 100) => {
  const harness = createAccessoryHarness({ data: [{ name: "position", value: resting }] });
  const handler = new WindowCoveringAccessory(harness.deps);
  const service = harness.serviceOf(harness.hap.Service.WindowCovering);
  const { CurrentPosition, TargetPosition, PositionState, HoldPosition } =
    harness.hap.Characteristic;
  const report = (position: number): void => {
    void handler.update([{ name: "position", value: position }], "data");
  };
  report(resting);
  return {
    ...harness,
    handler,
    report,
    current: service.getCharacteristic(CurrentPosition),
    target: service.getCharacteristic(TargetPosition),
    state: service.getCharacteristic(PositionState),
    hold: service.getCharacteristic(HoldPosition),
    STOPPED: PositionState.STOPPED,
    INCREASING: PositionState.INCREASING,
    DECREASING: PositionState.DECREASING,
  };
};

const flushWrite = () => vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

/**
 * What a gateway reached through the Delta Dore relay was seen to do (debug
 * trace of 2026-11-05): it acknowledges a position write by reporting the
 * target as if the shutter were already there, pushes the real position once or
 * twice while the motor runs, and sends nothing at all on arrival when the last
 * thing it reported was already the target.
 */
describe("WindowCoveringAccessory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("a position the user asked for", () => {
    it("is not overwritten by the position the shutter reports on its way", async () => {
      const { report, current, target, puts } = mount(100);

      await target.handleSet(43);
      await flushWrite();
      expect(puts).toEqual([[{ name: "position", value: 43 }]]);

      // The acknowledgement, then the real position a few seconds into the travel.
      report(43);
      report(88);

      // The shutter really is at 88, but the slider must keep showing 43: it
      // used to jump back to 88 for as long as the motor ran.
      expect(current.value).toBe(88);
      expect(target.value).toBe(43);
      expect(await target.handleGet()).toBe(43);
    });

    it("answers a read with the requested position, not the stale cached one", async () => {
      const { report, target } = mount(100);

      await target.handleSet(55);
      await flushWrite();
      report(90);

      expect(await target.handleGet()).toBe(55);
    });

    it("is released once the shutter reports having reached it", async () => {
      const { report, target, state, STOPPED } = mount(100);

      await target.handleSet(43);
      await flushWrite();
      report(43); // acknowledgement
      report(88); // on its way
      report(43); // arrival
      expect(state.value).toBe(STOPPED);

      // Someone uses the wall switch: that is a real change of target again.
      report(70);
      expect(target.value).toBe(70);
    });

    it("is released after the estimated travel time when no arrival is reported", async () => {
      const { report, target, state, STOPPED } = mount(100);
      const travelMs = 45 * TRAVEL_MS_PER_PERCENT + TRAVEL_MARGIN_MS;

      await target.handleSet(55);
      await flushWrite();
      report(55); // the last thing the gateway says: nothing follows on arrival

      await vi.advanceTimersByTimeAsync(travelMs - DEBOUNCE_MS - 1);
      report(70);
      expect(target.value).toBe(55);

      await vi.advanceTimersByTimeAsync(1);
      expect(state.value).toBe(STOPPED);
      report(70);
      expect(target.value).toBe(70);
    });

    it("is replaced by a newer one, which the earlier arrival does not release", async () => {
      const { report, target } = mount(100);

      await target.handleSet(55);
      await target.handleSet(30);
      await flushWrite();
      report(30);
      report(55); // the shutter passes 55 on its way down to 30

      expect(target.value).toBe(30);
      expect(await target.handleGet()).toBe(30);
    });

    it("follows a change made elsewhere when nothing is pending", () => {
      const { report, current, target } = mount(100);

      report(40);

      expect(current.value).toBe(40);
      expect(target.value).toBe(40);
    });
  });

  describe("travel direction", () => {
    it("shows the shutter closing, then stopped when it arrives", async () => {
      const { report, target, state, DECREASING, STOPPED } = mount(100);

      await target.handleSet(55);
      expect(state.value).toBe(DECREASING);
      expect(await state.handleGet()).toBe(DECREASING);

      await flushWrite();
      report(55);
      report(55);
      expect(await state.handleGet()).toBe(STOPPED);
    });

    it("shows the shutter opening for a higher target", async () => {
      const { target, state, INCREASING } = mount(20);

      await target.handleSet(80);

      expect(state.value).toBe(INCREASING);
    });
  });

  describe("repeated writes", () => {
    it("does not send the same position again while the finger rests on it", async () => {
      const { target, puts } = mount(55);

      // HomeKit repeats the value at every tick while the slider sits at an end stop.
      await target.handleSet(100);
      await flushWrite();
      await vi.advanceTimersByTimeAsync(800);
      await target.handleSet(100);
      await flushWrite();
      await vi.advanceTimersByTimeAsync(800);
      await target.handleSet(100);
      await flushWrite();

      expect(puts).toEqual([[{ name: "position", value: 100 }]]);
      // The repeat still counts as the user's wish.
      expect(await target.handleGet()).toBe(100);
    });

    it("sends it again once the repeat window has gone by", async () => {
      const { target, puts } = mount(55);

      await target.handleSet(100);
      await flushWrite();
      await vi.advanceTimersByTimeAsync(3_000);
      await target.handleSet(100);
      await flushWrite();

      expect(puts).toHaveLength(2);
    });

    it("sends a different position straight away", async () => {
      const { target, puts } = mount(55);

      await target.handleSet(60);
      await flushWrite();
      await vi.advanceTimersByTimeAsync(800);
      await target.handleSet(61);
      await flushWrite();

      expect(puts.map(([prop]) => prop?.value)).toEqual([60, 61]);
    });
  });

  describe("stop", () => {
    it("releases the requested position and forgets the last write", async () => {
      const { report, target, hold, state, puts, STOPPED } = mount(100);

      await target.handleSet(55);
      await flushWrite();
      report(55);

      await hold.handleSet(true);
      expect(puts.at(-1)).toEqual([{ name: "positionCmd", value: "STOP" }]);
      expect(state.value).toBe(STOPPED);

      // Where it actually stopped is reported as a real position.
      report(72);
      expect(target.value).toBe(72);

      // Asking for the same position again is a new order, not a repeat.
      await target.handleSet(55);
      await flushWrite();
      expect(puts.at(-1)).toEqual([{ name: "position", value: 55 }]);
    });
  });

  describe("dispose", () => {
    it("cancels the pending release", async () => {
      const { handler, target } = mount(100);

      await target.handleSet(55);
      handler.dispose();

      await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.toBeDefined();
    });
  });
});
