/**
 * The gateway answered, but the endpoint behind it did not.
 *
 * Transient in principle — a battery-powered device out of range, or a mains
 * device that lost power. Callers should surface it to HomeKit as "not
 * responding" rather than treating it as a plugin failure.
 */
export class UnreachableDeviceError extends Error {
  override readonly name = "UnreachableDeviceError";
  constructor(
    readonly uri: string,
    readonly code: number,
  ) {
    super(`Device at ${uri} is unreachable (error=${code})`);
  }
}

/** Any other non-zero `error` field on a Tydom response. */
export class TydomApiError extends Error {
  override readonly name = "TydomApiError";
  constructor(
    readonly uri: string,
    readonly code: number,
  ) {
    super(`${uri} reported error=${code}`);
  }
}

/**
 * The socket to the gateway is down, so the request was not even sent.
 *
 * Raised by the transport before reaching `tydom-client`, whose own message for
 * the same situation ("Socket instance is closing/closed, please reconnect with
 * connect() first") reads like a bug in the plugin and used to end up in the
 * Homebridge log once per characteristic read.
 */
export class GatewayDisconnectedError extends Error {
  override readonly name = "GatewayDisconnectedError";
  constructor() {
    super("Not connected to the Tydom gateway, a reconnection is in progress");
  }
}

/**
 * The messages `tydom-client` uses when the socket is down or a request was
 * lost with it. Matched on text because the library throws plain `Error`s.
 */
const CONNECTIVITY_MESSAGE =
  /socket instance is (missing|closing\/closed)|required socket instance|socket closed while request was pending|request timed out/i;

/**
 * Whether an error only says that the gateway cannot be reached right now.
 *
 * Those are expected while the connection is being re-established and say
 * nothing about the device, so they are not worth a warning per accessory.
 */
export const isConnectivityError = (err: unknown): boolean =>
  err instanceof GatewayDisconnectedError ||
  err instanceof UnreachableDeviceError ||
  (err instanceof Error && CONNECTIVITY_MESSAGE.test(err.message));
