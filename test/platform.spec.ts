import { stripVTControlCharacters } from "node:util";
import type { API as Homebridge, Logging, PlatformConfig } from "homebridge";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CATEGORY } from "../src/api/device-type.js";
import { DeltaDoreAuthError } from "../src/util/deltadore.js";
import type { TydomAccessoryContext } from "../src/typings/tydom.js";
import { metadataFrom } from "./helpers.js";

/**
 * Stub every accessory handler.
 *
 * These tests are about the platform's bookkeeping — which Homebridge calls it
 * makes, in what order — not about what a thermostat does. Building the real
 * handlers would drag in fakes for `Service.AccessoryInformation`, `addService`
 * and the whole `getCharacteristic().onGet().onSet()` chain, none of which the
 * bug lives in.
 */
const { disposed } = vi.hoisted(() => ({ disposed: [] as string[] }));
vi.mock("../src/accessories/registry.js", () => ({
  ACCESSORY_REGISTRY: new Proxy(
    {},
    {
      get:
        () =>
        ({ accessory }: { accessory: { UUID: string } }) => ({
          update: () => {},
          dispose: () => disposed.push(accessory.UUID),
        }),
    },
  ),
}));

// Imported after the mock is declared so the platform picks up the stub registry.
const { default: TydomPlatform } = await import("../src/platform.js");

type ApiCall = { op: "register" | "update" | "unregister"; uuids: string[] };

class FakePlatformAccessory {
  context = {} as TydomAccessoryContext;
  constructor(
    public displayName: string,
    public UUID: string,
    public category: number = 1,
  ) {}
  getService(): undefined {
    return undefined;
  }
}

/** Only what `TydomPlatform` actually reaches for on the Homebridge API. */
const createFakeApi = () => {
  const calls: ApiCall[] = [];
  const record =
    (op: ApiCall["op"]) =>
    (accessories: { UUID: string }[]): void => {
      calls.push({ op, uuids: accessories.map((accessory) => accessory.UUID) });
    };
  const api = {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: (value: string) => `uuid:${value}` },
    },
    platformAccessory: FakePlatformAccessory,
    on: () => api,
    registerPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: { UUID: string }[],
    ) => record("register")(accessories),
    updatePlatformAccessories: record("update"),
    unregisterPlatformAccessories: (
      _plugin: string,
      _platform: string,
      accessories: { UUID: string }[],
    ) => record("unregister")(accessories),
  };
  return { api, calls };
};

const createFakeLog = () => {
  const messages: string[] = [];
  /** What reaches the log at the default level, i.e. without debug. */
  const infos: string[] = [];
  const log = ((message: string) => messages.push(message)) as unknown as Logging & {
    messages: string[];
    infos: string[];
  };
  log.messages = messages;
  log.infos = infos;
  log.info = (message: string) => {
    messages.push(message);
    infos.push(message);
  };
  log.warn = (message: string) => messages.push(message);
  log.error = (message: string) => messages.push(message);
  log.debug = (message: string) => messages.push(message);
  log.success = (message: string) => messages.push(message);
  return log;
};

const config = {
  platform: "Tydom",
  hostname: "mediation.tydom.com",
  username: "001A25123456",
  password: "s3cret",
} as unknown as PlatformConfig;

const deviceContext = (
  overrides: Partial<TydomAccessoryContext> & { accessoryId: string },
): TydomAccessoryContext => ({
  name: "Lampe Salon",
  category: CATEGORY.LIGHTBULB,
  deviceType: "lightbulb",
  metadata: metadataFrom(["level"]),
  settings: {},
  state: {},
  deviceId: 1234,
  endpointId: 1234,
  ...overrides,
});

/**
 * Build a platform wired to fakes.
 *
 * `TydomController` is constructed by the platform itself and is not injectable,
 * but constructing it is harmless — `createTydomClient` only builds closures, so
 * nothing opens a socket. Keeping the real instance keeps its `device` listener
 * live; only the three network-facing methods are swapped out.
 */
const createPlatform = (contexts: TydomAccessoryContext[] = []) => {
  const { api, calls } = createFakeApi();
  const log = createFakeLog();
  const platform = new TydomPlatform(log, config, api as unknown as Homebridge);
  const controller = platform.controller!;
  controller.connect = async () => {};
  controller.dispose = () => {};
  const announced = [...contexts];
  controller.scan = async () => {
    for (const context of announced) {
      controller.emit("device", context);
    }
  };
  const announce = (next: TydomAccessoryContext[]) => {
    announced.splice(0, announced.length, ...next);
  };
  return { platform, calls, log, announce };
};

/**
 * The load-bearing invariant.
 *
 * `registerPlatformAccessories` is the only call that stamps an accessory's
 * plugin association; `updatePlatformAccessories` on an unassociated accessory
 * makes Homebridge's `PlatformAccessory.serialize` throw, which aborts the
 * entire cache write and leaves a duplicate behind in its cached array.
 *
 * `restored` seeds the association a cached accessory already carries: it was
 * deserialized with its plugin name, so persisting it needs no registration.
 */
const expectNoPrematureUpdate = (calls: ApiCall[], restored: string[] = []): void => {
  const registered = new Set<string>(restored);
  for (const call of calls) {
    if (call.op === "register") {
      call.uuids.forEach((uuid) => registered.add(uuid));
    }
    if (call.op === "update") {
      for (const uuid of call.uuids) {
        expect(registered.has(uuid), `persisted ${uuid} before registering it`).toBe(true);
      }
    }
  }
};

describe("TydomPlatform", () => {
  beforeEach(() => {
    disposed.length = 0;
  });

  it("registers a new accessory before it ever persists it", async () => {
    const { platform, calls } = createPlatform([deviceContext({ accessoryId: "a" })]);
    await platform.didFinishLaunching();
    expect(calls.map((call) => call.op)).toEqual(["register"]);
    expectNoPrematureUpdate(calls);
  });

  it("counts the accessories it loaded", async () => {
    const { platform, calls, log } = createPlatform([
      deviceContext({ accessoryId: "a" }),
      deviceContext({ accessoryId: "b" }),
      deviceContext({ accessoryId: "c" }),
    ]);
    // The handler only reaches `accessories.set` after an await, so make the
    // gap wide enough that a missing drain cannot pass by luck.
    const original = platform.handleControllerDevice.bind(platform);
    platform.handleControllerDevice = async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return original(context);
    };
    await platform.didFinishLaunching();
    expect(platform.accessories.size).toBe(3);
    expect(log.messages).toContain("Ready: 3 accessories (3 new)");
    expectNoPrematureUpdate(calls);
  });

  /**
   * The log used to carry four info lines per accessory, none of them saying
   * what was new, and named a device it left out only by its `firstUsage`.
   */
  it("reports each accessory on one info line, with its deviceId and what was left out", async () => {
    const { platform, log } = createPlatform();
    const controller = platform.controller!;
    controller.scan = async () => {
      controller.emit("device", deviceContext({ accessoryId: "a", name: "Cuisine", deviceId: 11 }));
      controller.emit("device", deviceContext({ accessoryId: "b", name: "Salon", deviceId: 22 }));
      controller.lastScan = {
        total: 3,
        skipped: [
          {
            deviceId: 33,
            endpointId: 33,
            name: "Mystery",
            firstUsage: "somethingNew",
            reason: "unsupported",
          },
        ],
      };
    };
    await platform.didFinishLaunching();

    const infos = log.infos.map((line) => stripVTControlCharacters(line));
    expect(infos).toEqual(
      expect.arrayContaining([
        "Gateway reports 3 devices (1 not supported), exposing 2 accessories to HomeKit:",
        "  lightbulb  Cuisine  id 11  new",
        "  lightbulb  Salon    id 22  new",
        "Not exposed: Mystery (somethingNew, id 33), this type of device is not supported yet",
        "Ready: 2 accessories (2 new)",
      ]),
    );
    // Once each, not once per step of the handler.
    expect(infos.filter((line) => line.includes("Cuisine"))).toHaveLength(1);
    expect(infos.filter((line) => line.includes("Salon"))).toHaveLength(1);
  });

  it("marks only the accessory the cache did not know as new", async () => {
    const known = deviceContext({ accessoryId: "a", name: "Lampe Salon", deviceId: 11 });
    const added = deviceContext({ accessoryId: "b", name: "Lampe Cuisine", deviceId: 22 });
    const { platform, log } = createPlatform([known, added]);
    const cached = new FakePlatformAccessory("Lampe Salon", "uuid:a", CATEGORY.LIGHTBULB);
    Object.assign(cached.context, known);
    platform.configureAccessory(cached as never);
    await platform.didFinishLaunching();

    const infos = log.infos.map((line) => stripVTControlCharacters(line));
    expect(infos).toContain("  lightbulb  Lampe Salon    id 11");
    expect(infos).toContain("  lightbulb  Lampe Cuisine  id 22  new");
    expect(infos).toContain("Ready: 2 accessories (1 new, 1 up to date)");
  });

  it("updates rather than re-registers an accessory Homebridge restored", async () => {
    const context = deviceContext({ accessoryId: "a" });
    const { platform, calls } = createPlatform([context]);
    const cached = new FakePlatformAccessory("Lampe Salon", "uuid:a", CATEGORY.LIGHTBULB);
    Object.assign(cached.context, context);
    platform.configureAccessory(cached as never);
    await platform.didFinishLaunching();
    expect(calls.map((call) => call.op)).toEqual(["update"]);
    expectNoPrematureUpdate(calls, ["uuid:a"]);
  });

  it("releases an accessory the startup sweep removed", async () => {
    const gone = deviceContext({ accessoryId: "a" });
    const kept = deviceContext({ accessoryId: "b", name: "Lampe Cuisine" });
    const { platform, calls, log, announce } = createPlatform([gone, kept]);
    await platform.didFinishLaunching();

    // The gateway still reports `b` but no longer reports `a`, so the sweep
    // unregisters `a`. A scan that reported neither would instead be treated as
    // an unreliable scan and prune nothing — see the zero-device test below.
    announce([kept]);
    await platform.didFinishLaunching();
    expect(platform.accessories.has("uuid:a")).toBe(false);
    expect(platform.handlers.has("uuid:a")).toBe(false);
    expect(disposed).toContain("uuid:a");
    expect(platform.accessories.has("uuid:b")).toBe(true);
    // The count used to include what the sweep had just removed.
    expect(log.messages).toContain("Ready: 1 accessory (1 removed, 1 up to date)");
    expect(log.messages.join("\n")).toMatch(/Removing .*Lampe Salon.* the gateway no longer/);
    expect(calls.filter((call) => call.op === "unregister")).toEqual([
      { op: "unregister", uuids: ["uuid:a"] },
    ]);
    expectNoPrematureUpdate(calls);
  });

  /**
   * A gateway that answers but reports nothing is indistinguishable, from the
   * sweep's point of view, from a user who deleted every device: discovery
   * announces nothing either way. A Tydom box does exactly that while it is
   * still booting, and the tolerant discovery schemas turn an empty
   * `/configs/file` into a clean scan of zero devices rather than an error.
   *
   * Unregistering is not recoverable: HomeKit drops the room assignment, the
   * name, and every scene and automation that referenced the accessory.
   */
  it("keeps every accessory when a scan discovers nothing at all", async () => {
    const context = deviceContext({ accessoryId: "a" });
    const { platform, calls, log, announce } = createPlatform([context]);
    await platform.didFinishLaunching();

    announce([]);
    await platform.didFinishLaunching();

    expect(platform.accessories.has("uuid:a")).toBe(true);
    expect(platform.handlers.has("uuid:a")).toBe(true);
    expect(disposed).not.toContain("uuid:a");
    expect(calls.filter((call) => call.op === "unregister")).toEqual([]);
    expect(log.messages.join("\n")).toMatch(/reported no devices/i);
  });

  /**
   * The shape a mediation outage actually takes: the relay accepts the login,
   * then every request on the socket dies. It used to surface as a bare
   * "Failed to finish launching", which reads like a plugin fault and sent
   * people hunting through their config for a mistake that was not there.
   */
  it("retries a scan that fails after connecting, on the same connection", async () => {
    vi.useFakeTimers();
    try {
      const context = deviceContext({ accessoryId: "a" });
      const { platform, calls, log } = createPlatform([context]);
      const controller = platform.controller!;
      const state = controller as unknown as { hasConnectedOnce: boolean; connected: boolean };
      let connects = 0;
      controller.connect = async () => {
        connects += 1;
        state.hasConnectedOnce = true;
        state.connected = true;
      };
      const scan = controller.scan.bind(controller);
      let failures = 1;
      controller.scan = async () => {
        if (failures-- > 0) {
          throw new Error("Socket closed while request was pending");
        }
        return scan();
      };

      const launching = platform.didFinishLaunching();
      await vi.advanceTimersByTimeAsync(5_000);
      await launching;

      const messages = log.messages.join("\n");
      expect(messages).toMatch(/Reading the device list attempt 1 failed/);
      expect(messages).toMatch(/Socket closed while request was pending/);
      expect(messages).not.toMatch(/Failed to finish launching/);
      // The controller reconnects by itself once connected: no second socket.
      expect(connects).toBe(1);
      expect(platform.accessories.has("uuid:a")).toBe(true);
      expect(calls.filter((call) => call.op === "unregister")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps trying to connect instead of giving up after ten attempts", async () => {
    vi.useFakeTimers();
    try {
      const context = deviceContext({ accessoryId: "a" });
      const { platform } = createPlatform([context]);
      const controller = platform.controller!;
      let attempts = 0;
      controller.connect = async () => {
        attempts += 1;
        if (attempts <= 15) {
          throw new Error("getaddrinfo ENOTFOUND mediation.tydom.com");
        }
      };

      const launching = platform.didFinishLaunching();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      await launching;

      expect(attempts).toBe(16);
      expect(platform.accessories.has("uuid:a")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets a companion link when the primary is swept", async () => {
    const primary = deviceContext({
      accessoryId: "alarm",
      name: "Alarme",
      category: CATEGORY.SECURITY_SYSTEM,
      deviceType: "alarm",
    });
    const companion = deviceContext({
      accessoryId: "alarm:sensors",
      name: "Issues ouvertes",
      category: CATEGORY.SENSOR,
      deviceType: "alarm-sensors",
      companionOf: "alarm",
    });
    // A survivor, so the sweep trusts the scan enough to prune at all.
    const kept = deviceContext({ accessoryId: "b", name: "Lampe Cuisine" });
    const { platform, announce } = createPlatform([primary, companion, kept]);
    await platform.didFinishLaunching();
    expect(platform.companions.get("uuid:alarm")).toEqual(["uuid:alarm:sensors"]);

    announce([kept]);
    await platform.didFinishLaunching();
    expect(platform.companions.size).toBe(0);
  });

  it("stays up and reports a bad webhook rather than going dormant", async () => {
    // The point of the change: a typo in a notification URL must not cost the
    // user every accessory. The platform loads, and says what it dropped.
    const { api, calls } = createFakeApi();
    const log = createFakeLog();
    const platform = new TydomPlatform(
      log,
      { ...config, webhooks: [{ url: "nope", type: "discord" }] } as unknown as PlatformConfig,
      api as unknown as Homebridge,
    );
    expect(platform.disabled).toBe(false);
    const controller = platform.controller!;
    controller.connect = async () => {};
    controller.dispose = () => {};
    controller.scan = async () => {
      controller.emit("device", deviceContext({ accessoryId: "a" }));
    };
    await platform.didFinishLaunching();

    expect(platform.accessories.size).toBe(1);
    expect(log.messages.join("\n")).toMatch(/Ignoring webhook 0/);
    expectNoPrematureUpdate(calls);
  });

  it("stops retrying when Delta Dore rejects the account credentials", async () => {
    const { platform, log } = createPlatform();
    let attempts = 0;
    platform.controller!.connect = async () => {
      attempts += 1;
      throw new DeltaDoreAuthError("Delta Dore rejected the account password.");
    };
    await platform.didFinishLaunching();
    // One attempt, not eleven. The retry ladder would otherwise re-submit the
    // same wrong password to Azure AD B2C over ~25 minutes, which earns a
    // lockout and never a connection.
    expect(attempts).toBe(1);
    expect(log.messages).toContain("Delta Dore rejected the account password.");
    // And the misleading gateway-unreachable line must not appear.
    expect(log.messages.join("\n")).not.toContain("Failed to connect after");
  });

  it("still retries a transient connection failure", async () => {
    const { platform } = createPlatform();
    let attempts = 0;
    platform.controller!.connect = async () => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("ECONNREFUSED");
      }
    };
    // The first retry waits 5s; run the ladder on fake timers so the test does
    // not actually sleep through it.
    vi.useFakeTimers();
    const launching = platform.didFinishLaunching();
    await vi.advanceTimersByTimeAsync(5000);
    await launching;
    vi.useRealTimers();
    expect(attempts).toBe(2);
  });

  it("replaces an accessory whose category changed", async () => {
    const context = deviceContext({ accessoryId: "a" });
    const { platform, calls } = createPlatform([context]);
    // A cached accessory registered under a category the gateway no longer
    // reports for this device.
    const cached = new FakePlatformAccessory("Lampe Salon", "uuid:a", CATEGORY.SWITCH);
    Object.assign(cached.context, context);
    platform.configureAccessory(cached as never);
    await platform.didFinishLaunching();
    expect(calls.map((call) => call.op)).toEqual(["unregister", "register"]);
    expectNoPrematureUpdate(calls, ["uuid:a"]);
  });
});
