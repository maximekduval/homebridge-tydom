import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { ScanReport } from "../src/api/discovery.js";
import { deviceTableLines, readyLine, type StartupRow } from "../src/platform/startup-report.js";

const row = (overrides: Partial<StartupRow> = {}): StartupRow => ({
  id: "uuid",
  type: "window-covering",
  name: "Cuisine",
  deviceId: 1681724571,
  status: "known",
  ...overrides,
});

const plain = (lines: string[]): string[] => lines.map((line) => stripVTControlCharacters(line));

describe("deviceTableLines", () => {
  it("lists one aligned line per accessory, with its deviceId", () => {
    const lines = plain(
      deviceTableLines(
        [row(), row({ name: "Salle a manger", deviceId: 1681724621 }), row({ type: "light" })],
        { total: 3, skipped: [] },
      ),
    );
    expect(lines).toEqual([
      "Gateway reports 3 devices, exposing 3 accessories to HomeKit:",
      "  window-covering  Cuisine         id 1681724571",
      "  window-covering  Salle a manger  id 1681724621",
      "  light            Cuisine         id 1681724571",
    ]);
  });

  it("marks what is new or was rebuilt, and nothing else", () => {
    const lines = plain(
      deviceTableLines(
        [
          row({ status: "new" }),
          row({ name: "Salon", status: "recreated" }),
          row({ name: "Bureau" }),
        ],
        undefined,
      ),
    );
    expect(lines).toEqual([
      "Exposing 3 accessories to HomeKit:",
      "  window-covering  Cuisine  id 1681724571  new",
      "  window-covering  Salon    id 1681724571  recreated",
      "  window-covering  Bureau   id 1681724571",
    ]);
  });

  it("names what it left out, instead of only counting it", () => {
    const scan: ScanReport = {
      total: 4,
      skipped: [
        {
          deviceId: 1687207905,
          endpointId: 1687207905,
          name: "Mystery",
          firstUsage: "somethingNew",
          reason: "unsupported",
        },
        { deviceId: 5, endpointId: 5, name: "Cave", firstUsage: "light", reason: "filtered" },
      ],
    };
    expect(plain(deviceTableLines([row()], scan))).toEqual([
      "Gateway reports 4 devices (1 not supported, 1 excluded by your settings), exposing 1 accessory to HomeKit:",
      "  window-covering  Cuisine  id 1681724571",
      "Not exposed: Mystery (somethingNew, id 1687207905), this type of device is not supported yet",
    ]);
  });

  it("does not leave a dangling colon when nothing is exposed", () => {
    expect(plain(deviceTableLines([], { total: 0, skipped: [] }))).toEqual([
      "Gateway reports 0 devices, exposing 0 accessories to HomeKit",
    ]);
  });
});

describe("readyLine", () => {
  it("says nothing changed rather than listing zeros", () => {
    expect(readyLine(2, [row(), row()], 0)).toBe("Ready: 2 accessories, all up to date");
  });

  it("leads with what changed and ends with what did not", () => {
    const rows = [row({ status: "new" }), row({ status: "recreated" }), row()];
    expect(readyLine(3, rows, 2)).toBe(
      "Ready: 3 accessories (1 new, 1 recreated, 2 removed, 1 up to date)",
    );
  });

  it("leaves out 'up to date' on a first start", () => {
    expect(readyLine(1, [row({ status: "new" })], 0)).toBe("Ready: 1 accessory (1 new)");
  });
});
