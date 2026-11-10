import { EventEmitter } from "node:events";
import type { Logging } from "homebridge";
import type { Categories } from "homebridge";
import { createTranslator, type Translator } from "./i18n/index.js";
import {
  discoverDevices,
  expandCompanions,
  type DiscoveredDevice,
  type ScanReport,
} from "./api/discovery.js";
import {
  classifyMessage,
  getAccessoryId,
  getUniqueId,
  parseDeviceDataUpdate,
} from "./api/messages.js";
import {
  parseDiscoveryResponse,
  tydomConfigResponseSchema,
  tydomGroupsResponseSchema,
  tydomCommandMetaResponseSchema,
  tydomMetaResponseSchema,
  type TydomUpdateType,
} from "./api/types.js";
import type { TydomUpdateType as TydomAccessoryUpdateType } from "./api/types.js";
import { asyncWait, withTimeout } from "./util/async.js";
import type { TydomPlatformConfig } from "./platform.js";
import type {
  TydomAccessoryContext,
  TydomAccessoryUpdateContext,
  TydomConfigResponse,
  TydomGroupsResponse,
  TydomCommandMetaResponse,
  TydomMetaResponse,
} from "./typings/tydom.js";
import {
  styleGet,
  styleJson,
  styleKeyword,
  styleNumber,
  styleString,
  styleUpd,
} from "./util/style.js";
import { debug } from "./platform/trace.js";
import { stringifyError } from "./util/error.js";
import { resolveGatewayPassword } from "./util/deltadore.js";
import { maskEmail } from "./util/redact.js";
import type TydomClient from "tydom-client";
import {
  createClient as createTydomClient,
  type TydomHttpMessage,
  type TydomResponse,
} from "tydom-client";

export type ControllerDevicePayload = TydomAccessoryContext;

/** Builds a `tydom-client` instance. Injectable so tests can count clients. */
export type TydomClientFactory = (options: TydomClientOptions) => TydomClient;

type TydomClientOptions = Parameters<typeof createTydomClient>[0];

/** First wait before reconnecting, doubled after each failed attempt. */
export const RECONNECT_BASE_DELAY_MS = 2_000;
/**
 * Longest wait between two reconnection attempts.
 *
 * `tydom-client` caps its own backoff at 2^31 ms, about 25 days, and counts
 * every attempt twice, so a gateway or a Delta Dore outage of an hour or two
 * left the plugin waiting for many hours — "No Response" until Homebridge was
 * restarted. A minute is cheap for the gateway and short enough to be invisible
 * once the network is back.
 */
export const RECONNECT_MAX_DELAY_MS = 60_000;
/**
 * Longest a connection attempt may take, login included.
 *
 * Neither the login request nor the WebSocket handshake of `tydom-client` has a
 * timeout, so an attempt that hung (a half-open TCP connection after a network
 * change, a gateway rebooting mid-handshake) stopped every later reconnection.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

export type ControllerUpdatePayload = {
  type: TydomAccessoryUpdateType;
  category: Categories;
  updates: Record<string, unknown>[];
  context: TydomAccessoryContext;
};

export default class TydomController extends EventEmitter {
  public client: TydomClient;
  public config: TydomPlatformConfig;
  public log: Logging;
  /**
   * Known endpoints, by `deviceId:endpointId`.
   *
   * Only a gate for inbound pushes — `handleDeviceDataUpdate` uses it to tell a
   * device it discovered from one it did not. Companions share their primary's
   * endpoint, so only the primary ever writes here.
   */
  private devices = new Map<string, Categories>();
  /**
   * Accessories already announced to the platform, by `accessoryId`.
   *
   * Separate from `devices` because a companion shares the primary's endpoint
   * but is a distinct accessory. Deduping the announcement on the endpoint
   * instead — which is what this used to do — silently swallowed every
   * companion, since the primary always claimed the key first.
   */
  private emitted = new Set<string>();
  /**
   * What the last completed scan found, including the endpoints it left out.
   *
   * A property rather than the return value of `scan`, which announces the
   * devices through events: the platform reads it once the announced devices
   * have settled, to report them together.
   */
  lastScan: ScanReport | undefined;
  private refreshInterval: NodeJS.Timeout | undefined;
  private hasConnectedOnce = false;
  /**
   * Whether a socket is currently up.
   *
   * The platform's startup ladder consults this so it does not open a second
   * socket next to the one the reconnection loop brought back.
   */
  private connected = false;
  /**
   * Set by `dispose`, and never cleared.
   *
   * The clients are built with `retryOnClose: false`, so closing one no longer
   * makes it reconnect behind our back; the flag still guards the timers and
   * the events that may already be on their way.
   */
  private disposed = false;
  /** The pending reconnection, if one is scheduled. */
  private reconnectTimer: NodeJS.Timeout | undefined;
  /** A reconnection attempt is running. */
  private reconnecting = false;
  /** Failed attempts since the connection was last re-synced successfully. */
  private reconnectAttempts = 0;
  /** When the socket last dropped, for the reconnection message. */
  private disconnectedAt: number | undefined;
  /** Logged the "still unreachable" warning for the current outage. */
  private warnedUnreachable = false;
  private readonly clientFactory: TydomClientFactory;
  /**
   * The gateway password actually in use.
   *
   * Empty until `connect` derives it, when the platform was configured with an
   * account e-mail — in which case `config.password` is the account's, not the
   * gateway's, and must never reach the gateway.
   */
  private gatewayPassword: string;
  /** Delta Dore label lookups, bound to the configured locale. */
  private readonly t: Translator;
  constructor(
    log: Logging,
    config: TydomPlatformConfig,
    clientFactory: TydomClientFactory = createTydomClient,
  ) {
    super();
    this.clientFactory = clientFactory;
    this.config = config;
    this.log = log;
    this.t = createTranslator(config.locale);
    // hostname/username/password are validated and resolved by parseConfig,
    // so there is nothing left to assert here.
    const { hostname, username, password, email } = config;
    debug(
      `Creating tydom client with username=${styleString(username)} and hostname=${styleString(hostname)}`,
    );
    // With an e-mail configured, `password` belongs to the account rather than
    // the gateway, so the client starts out with no usable credential and
    // `connect` fills one in.
    this.gatewayPassword = email ? "" : password;
    this.client = this.createClient(this.gatewayPassword);
  }
  /**
   * Build a client for `password` and wire its events up.
   *
   * Split out of the constructor because account-derived credentials only
   * arrive once `connect` has been able to await the account API, and the
   * client takes its password at construction time.
   */
  private createClient(password: string): TydomClient {
    const { hostname, username } = this.config;
    const client = this.clientFactory({
      username,
      password,
      hostname,
      followUpDebounce: 500,
      // The controller owns reconnection (see `scheduleReconnect`): the
      // library's own loop backs off for days and stalls on a hung attempt.
      retryOnClose: false,
      // Homebridge's `shutdown` reaches `dispose`, which closes the socket. The
      // library's SIGINT/SIGTERM listeners would add one pair per client, and a
      // client is replaced after every attempt that times out.
      closeOnExit: false,
    });
    client.on("message", (message: TydomHttpMessage) => {
      try {
        this.handleMessage(message);
      } catch (err) {
        this.log.error(
          `Encountered an uncaught error=${stringifyError(err as Error)} while processing message=${styleJson(message)}"`,
        );
      }
    });
    client.on("connect", () => {
      if (this.disposed) {
        return;
      }
      this.connected = true;
      this.clearReconnectTimer();
      if (!this.hasConnectedOnce) {
        this.log.info(
          `Connected to Tydom gateway ${styleString(username)} via ${styleString(hostname)}`,
        );
      }
      this.emit("connect");
    });
    client.on("disconnect", () => this.resetClient(client));
    return client;
  }

  private resetClient(client: TydomClient): void {
    if (this.disposed || this.client !== client) {
      return;
    }
    this.closeClient(client);
    this.client = this.createClient(this.gatewayPassword);
    if (this.connected) {
      this.connected = false;
      this.disconnectedAt ??= Date.now();
      debug(
        `Disconnected from Tydom hostname=${styleString(this.config.hostname)}, reconnecting...`,
      );
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    this.emit("disconnect");
    this.scheduleReconnect();
  }

  /**
   * Detach the client immediately and close a socket that opens after we gave
   * up on its login or handshake.
   */
  private closeClient(client: TydomClient): void {
    client.removeAllListeners();
    const close = () => {
      try {
        client.close();
      } catch (err) {
        debug(`Ignoring error while closing the Tydom client: ${String(err)}`);
      }
    };
    client.once("connect", close);
    close();
  }

  private async openSocket(client: TydomClient): Promise<void> {
    await withTimeout(
      client.connect(),
      CONNECT_TIMEOUT_MS,
      `Connecting to ${this.config.hostname} timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
    );
  }

  private async pingAfterConnect(client: TydomClient): Promise<void> {
    await asyncWait(250);
    this.checkConnection(client);
    await client.get("/ping");
    this.checkConnection(client);
  }

  private checkConnection(client: TydomClient): void {
    if (this.disposed || this.client !== client || !this.connected) {
      throw new Error("Tydom socket closed before synchronization finished");
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Reconnect after the socket dropped, with a capped exponential backoff.
   *
   * Only once the first connection succeeded: before that, the platform's
   * startup ladder is in charge. Never more than one attempt or one timer at a
   * time, however many `disconnect` events a failing attempt produces.
   */
  private scheduleReconnect(): void {
    if (this.disposed || !this.hasConnectedOnce || this.reconnecting || this.reconnectTimer) {
      return;
    }
    const delay = reconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts += 1;
    debug(`Reconnecting to hostname=${styleString(this.config.hostname)} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.disposed || this.connected) {
      return;
    }
    this.reconnecting = true;
    const client = this.client;
    const hostname = styleString(this.config.hostname);
    try {
      await this.openSocket(client);
      await this.pingAfterConnect(client);
      await client.post("/refresh/all");
      this.checkConnection(client);
      this.scheduleRefresh();

      const downFor = Date.now() - (this.disconnectedAt ?? Date.now());
      this.disconnectedAt = undefined;
      this.reconnectAttempts = 0;
      const status = this.warnedUnreachable ? "is reachable again" : "reconnected";
      this.warnedUnreachable = false;
      this.log.info(
        `Tydom hostname=${hostname} ${status} after ${Math.round(downFor / 1000)}s, state re-synced`,
      );
    } catch (err) {
      this.resetClient(client);
      if (this.disposed) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (
        !this.warnedUnreachable &&
        reconnectDelay(this.reconnectAttempts) >= RECONNECT_MAX_DELAY_MS
      ) {
        this.warnedUnreachable = true;
        this.log.warn(
          `Tydom hostname=${hostname} is still unreachable (${message}), ` +
            `waiting about ${RECONNECT_MAX_DELAY_MS / 1000}s between attempts`,
        );
      }
      debug(
        `Reconnection attempt ${this.reconnectAttempts} failed: ${stringifyError(err as Error)}`,
      );
    } finally {
      this.reconnecting = false;
    }
    if (!this.connected) {
      this.scheduleReconnect();
    }
  }
  /**
   * Fetch the gateway password from the Delta Dore account, once.
   *
   * No-op unless an account e-mail was configured. The result is kept for the
   * process lifetime: the gateway password is stable, and `connect` is retried
   * with backoff on startup — re-running the whole OAuth flow on every attempt
   * would turn a flaky socket into repeated sign-ins.
   */
  private async resolveGatewayPassword(): Promise<void> {
    const { email, password: accountPassword, username } = this.config;
    if (this.gatewayPassword || !email) {
      return;
    }
    this.log.info(
      `Resolving the gateway password from the Delta Dore account of ${styleString(maskEmail(email))}...`,
    );
    const password = await resolveGatewayPassword({
      email,
      password: accountPassword,
      mac: username,
    });
    if (this.disposed) {
      return;
    }
    this.gatewayPassword = password;
    // The client takes its password at construction, so the placeholder built
    // in the constructor has to be replaced rather than reconfigured. Nothing
    // has connected yet, so there is no socket to migrate — only listeners.
    this.client.removeAllListeners();
    this.client = this.createClient(password);
    this.log.info(
      `Got the password of gateway ${styleString(username)} from your Delta Dore account`,
    );
  }
  /** Whether the socket is up and any reconnection has been synchronized. */
  get isConnected(): boolean {
    return this.connected && !this.reconnecting;
  }

  /**
   * Whether `connect` has succeeded once. From then on the controller
   * reconnects by itself, and nobody else should call `connect` again.
   */
  get hasConnected(): boolean {
    return this.hasConnectedOnce;
  }

  async connect(): Promise<void> {
    const { hostname, username } = this.config;
    debug(`Connecting to hostname=${styleString(hostname)}...`);
    // Outside the try below, and before the socket: a rejected account
    // credential is not a failure to reach the gateway, and reporting it as one
    // hides the only thing the user can act on. `didFinishLaunching` recognises
    // `DeltaDoreAuthError` and stops rather than retrying it.
    await this.resolveGatewayPassword();
    if (this.disposed) {
      return;
    }
    const client = this.client;
    try {
      await this.openSocket(client);
      await this.pingAfterConnect(client);
      this.disconnectedAt = undefined;
      this.hasConnectedOnce = true;
    } catch (err) {
      this.resetClient(client);
      this.log.error(`Failed to connect to Tydom hostname=${hostname} with username="${username}"`);
      throw err;
    }
  }
  async sync(): Promise<{
    config: TydomConfigResponse;
    groups: TydomGroupsResponse;
    meta: TydomMetaResponse;
    cmeta: TydomCommandMetaResponse;
  }> {
    const { hostname } = this.config;
    debug(`Syncing state from hostname=${styleString(hostname)}...`);
    // Checked rather than cast: everything downstream assumes these shapes, and
    // an unnoticed change here would surface as a TypeError deep inside
    // discovery instead of naming the endpoint that actually moved.
    const config = parseDiscoveryResponse(
      "/configs/file",
      tydomConfigResponseSchema,
      await this.client.get("/configs/file"),
    );
    const groups = parseDiscoveryResponse(
      "/groups/file",
      tydomGroupsResponseSchema,
      await this.client.get("/groups/file"),
    );
    const meta = parseDiscoveryResponse(
      "/devices/meta",
      tydomMetaResponseSchema,
      await this.client.get("/devices/meta"),
    );
    // Which commands each endpoint accepts, and with which values. Tolerated
    // rather than required: it is only used to decide whether to publish an
    // optional capability, so a gateway that will not answer should lose that
    // capability, not its whole scan.
    let cmeta: TydomCommandMetaResponse = [];
    try {
      cmeta = parseDiscoveryResponse(
        "/devices/cmeta",
        tydomCommandMetaResponseSchema,
        await this.client.get("/devices/cmeta"),
      );
    } catch (err) {
      this.log.warn(
        `Could not read command metadata, so optional device capabilities stay off: ${stringifyError(err as Error)}`,
      );
    }
    // Final outro handshake
    await this.refresh();
    this.scheduleRefresh();
    return { config, groups, meta, cmeta };
  }
  async scan(): Promise<void> {
    const { hostname, username, settings = {} } = this.config;
    this.log.info("Reading the device list...");
    debug(`Scanning devices from hostname=${styleString(hostname)}...`);
    const { config, groups, meta, cmeta } = await this.sync();

    const { devices, skipped } = discoverDevices({
      username,
      config,
      groups,
      meta,
      cmeta,
      settings,
      filters: {
        includedDevices: this.config.includedDevices,
        excludedDevices: this.config.excludedDevices,
        includedCategories: this.config.includedCategories,
        excludedCategories: this.config.excludedCategories,
      },
    });

    // Left for the platform to report once, as part of its startup device list:
    // a line per endpoint here read as four per accessory in the log.
    this.lastScan = { total: config.endpoints.length, skipped };

    for (const device of devices.flatMap((d) => expandCompanions(d))) {
      const { uniqueId, deviceId, endpointId, firstUsage, category } = device;
      if (this.emitted.has(device.accessoryId)) {
        continue;
      }
      this.emitted.add(device.accessoryId);
      debug(
        `Announcing device with firstUsage=${styleString(firstUsage)}, deviceId=${styleNumber(
          deviceId,
        )} and endpointId=${styleNumber(endpointId)}`,
      );
      // A companion carries a synthetic category that must not overwrite the
      // real one its primary registered for the same endpoint.
      if (!device.companionOf) {
        this.devices.set(uniqueId, category as Categories);
      }
      const context: TydomAccessoryContext = {
        name: this.accessoryName(device),
        category: category as Categories,
        deviceType: device.deviceType,
        metadata: device.metadata,
        commands: device.commands,
        settings: device.settings,
        group: device.group,
        deviceId,
        endpointId,
        accessoryId: device.accessoryId,
        ...(device.companionOf ? { companionOf: device.companionOf } : {}),
        manufacturer: "Delta Dore",
        serialNumber: `ID${deviceId}`,
        state: {},
      };
      this.emit("device", context);
    }
  }
  /**
   * The name an accessory is announced under.
   *
   * Discovery stays framework-free, so the names that come from the locale
   * tables are filled in here. A name the user set in `settings` always wins.
   */
  private accessoryName(device: DiscoveredDevice): string {
    if (device.deviceType === "alarm-sensors") {
      return this.t("ALARME_ISSUES_OUVERTES", device.name);
    }
    // The gateway names its weather source `Invisible 1`, which would be the
    // tile's name in the Home app.
    if (device.firstUsage === "weather" && device.settings.name === undefined) {
      return this.t("PLUGIN_OUTDOOR_WEATHER", device.name);
    }
    return device.name;
  }
  async refresh(): Promise<void> {
    debug(`Refreshing Tydom controller ...`);
    await this.client.post("/refresh/all");
  }
  /** Install the periodic full refresh after synchronization. */
  private scheduleRefresh(): void {
    const { refreshIntervalMs } = this.config;
    if (this.refreshInterval) {
      debug(`Removing existing refresh interval`);
      clearInterval(this.refreshInterval);
    }
    debug(`Configuring refresh interval of ${styleNumber(Math.round(refreshIntervalMs / 1000))}s`);
    this.refreshInterval = setInterval(() => {
      this.refresh().catch((err: unknown) => {
        // Warn rather than debug: a gateway that has quietly stopped accepting
        // refreshes leaves every reading to go stale, and that is invisible in
        // a normal log if it only ever reaches the debug sink.
        this.log.warn(`Failed interval refresh: ${stringifyError(err as Error)}`);
      });
    }, refreshIntervalMs);
    this.refreshInterval.unref?.();
  }
  /**
   * Stop the timers and close the socket. Idempotent.
   *
   * Listeners come off before the close, so the `disconnect` it causes does not
   * schedule a reconnection or push state into handlers that are gone.
   */
  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    this.connected = false;
    this.closeClient(this.client);
  }

  handleMessage(message: TydomHttpMessage): void {
    const { uri, method, body } = message;
    const type = classifyMessage(uri, method);
    if (type === "unknown") {
      debug(`Unknown message from Tydom client:\n${styleJson(message)}`);
      return;
    }
    this.handleDeviceDataUpdate(body, type);
  }

  handleDeviceDataUpdate(body: TydomResponse, type: TydomUpdateType): void {
    for (const update of parseDeviceDataUpdate(body, type)) {
      const { deviceId, endpointId, updates } = update;
      const uniqueId = getUniqueId(deviceId, endpointId);
      const category = this.devices.get(uniqueId);
      if (category === undefined) {
        debug(
          `${styleUpd("\u2190PUT")}:${styleKeyword("ignored")} for device id=${styleString(
            deviceId,
          )} and endpointId=${styleNumber(endpointId)}`,
        );
        continue;
      }
      debug(
        `${styleGet("\u2190PUT")}:${styleKeyword("update")} for deviceId=${styleNumber(
          deviceId,
        )} and endpointId=${styleNumber(endpointId)}, updates:\n${styleJson(updates)}`,
      );
      const context: TydomAccessoryUpdateContext = {
        category,
        deviceId,
        endpointId,
        accessoryId: getAccessoryId(this.config.username, deviceId, endpointId),
      };
      this.emit("update", { type, updates, context } as ControllerUpdatePayload);
    }
  }
}

/** Capped exponential backoff with a little jitter, for `attempt` failures so far. */
export const reconnectDelay = (attempt: number, random: () => number = Math.random): number =>
  Math.min(RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt, 16), RECONNECT_MAX_DELAY_MS) +
  Math.round(random() * 500);
