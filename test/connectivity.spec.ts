import { describe, expect, it } from "vitest";
import { createWindowCoveringAccessory } from "../src/accessories/window-covering-accessory.js";
import { GatewayDisconnectedError, isConnectivityError } from "../src/api/errors.js";
import { createAccessoryHarness } from "./accessory-harness.js";
import { HapStatusError, HAPStatus } from "./hap-double.js";

const SOCKET_CLOSED = "Socket instance is closing/closed, please reconnect with connect() first";

/**
 * A shutter whose gateway can be cut off mid-test.
 *
 * `staleAfterMs` is non-zero, as in the shipped default, so a read that has
 * succeeded once is held in memory.
 */
const mountShutter = (staleAfterMs = 60_000) => {
  const harness = createAccessoryHarness({
    data: [{ name: "position", value: 40 }],
    staleAfterMs,
  });
  const handler = createWindowCoveringAccessory(harness.deps);
  const api = harness.deps.api as unknown as Record<string, unknown>;
  const cutOff = (error: Error = new Error(SOCKET_CLOSED)) => {
    api["getDeviceData"] = async () => {
      throw error;
    };
    api["putDeviceData"] = async () => {
      throw error;
    };
  };
  const service = harness.serviceOf(harness.hap.Service.WindowCovering);
  const characteristic = (name: string) =>
    service.getCharacteristic(
      (harness.hap.Characteristic as unknown as Record<string, { name: string }>)[name]!,
    );
  return { ...harness, handler, cutOff, characteristic };
};

describe("reads while the gateway is unreachable", () => {
  it("answers with the last known state instead of throwing", async () => {
    // The Home app opening during one of Delta Dore's relay drops used to log
    // "This plugin threw an error from the characteristic 'Current Position'"
    // for every shutter.
    const { cutOff, characteristic, messages, handler } = mountShutter(0);
    expect(await characteristic("CurrentPosition").handleGet()).toBe(40);

    cutOff();
    expect(await characteristic("CurrentPosition").handleGet()).toBe(40);
    expect(await characteristic("TargetPosition").handleGet()).toBe(40);
    expect(messages.filter((m) => !m.startsWith("debug"))).toEqual([]);
    handler.dispose();
  });

  it("reports No Response, quietly, when nothing was read yet", async () => {
    const { cutOff, characteristic, messages, handler } = mountShutter();
    cutOff();

    const error = await characteristic("CurrentPosition")
      .handleGet()
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(HapStatusError);
    expect((error as HapStatusError).hapStatus).toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    expect(messages.filter((m) => !m.startsWith("debug"))).toEqual([]);
    handler.dispose();
  });

  it("still warns about a read failure that is not a connectivity problem", async () => {
    const { cutOff, characteristic, messages, handler } = mountShutter();
    cutOff(new TypeError("Cannot read properties of undefined"));

    await expect(characteristic("CurrentPosition").handleGet()).rejects.toBeInstanceOf(
      HapStatusError,
    );
    expect(messages.some((m) => m.startsWith("warn") && m.includes("Cannot read"))).toBe(true);
    handler.dispose();
  });

  it("turns a failed write into No Response and logs it", async () => {
    const { cutOff, characteristic, messages, handler } = mountShutter();
    cutOff(new GatewayDisconnectedError());

    await expect(characteristic("HoldPosition").handleSet(true)).rejects.toBeInstanceOf(
      HapStatusError,
    );
    expect(messages.some((m) => m.startsWith("warn") && m.includes("Could not write"))).toBe(true);
    handler.dispose();
  });
});

describe("isConnectivityError", () => {
  it.each([
    SOCKET_CLOSED,
    "Socket closed while request was pending",
    "Request timed out after 5000ms",
    "Required socket instance, please use connect() first",
  ])("recognises %s", (message) => {
    expect(isConnectivityError(new Error(message))).toBe(true);
  });

  it("recognises the transport's own error", () => {
    expect(isConnectivityError(new GatewayDisconnectedError())).toBe(true);
  });

  it("does not swallow other errors", () => {
    expect(isConnectivityError(new TypeError("x is undefined"))).toBe(false);
    expect(isConnectivityError("Socket closed")).toBe(false);
  });
});
