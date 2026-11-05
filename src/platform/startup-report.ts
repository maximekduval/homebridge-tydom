import type { ScanReport } from "../api/discovery.js";
import { styleGet, styleKeyword, styleNumber, styleUpd } from "../util/style.js";

/**
 * One accessory of the startup report.
 *
 * `known` is an accessory Homebridge already had and the gateway still reports;
 * `recreated` one whose HomeKit category changed, so it was rebuilt.
 */
export type StartupRow = {
  /** HomeKit UUID, to drop the rows whose accessory never made it. */
  id: string;
  /** What the plugin exposes it as, e.g. `window-covering`. */
  type: string;
  name: string;
  deviceId: number;
  status: "new" | "known" | "recreated";
};

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const statusMarker = (status: StartupRow["status"]): string => {
  switch (status) {
    case "new":
      return `  ${styleGet("new")}`;
    case "recreated":
      return `  ${styleUpd("recreated")}`;
    default:
      return "";
  }
};

/**
 * The device list, as the lines to log at info level.
 *
 * One line per accessory with its `deviceId`, which `includedDevices` and
 * `settings` are keyed by and which users have no other way to read. What the
 * plugin left out is named, rather than reported by `firstUsage` alone: a
 * missing accessory should be explained by the log, not found by elimination.
 */
export const deviceTableLines = (rows: StartupRow[], scan: ScanReport | undefined): string[] => {
  const exposed = count(rows.length, "accessory", "accessories");
  const colon = rows.length > 0 ? ":" : "";
  const unsupported = scan?.skipped.filter(({ reason }) => reason === "unsupported") ?? [];
  const lines: string[] = [];

  if (scan) {
    const notes = [];
    if (unsupported.length > 0) {
      notes.push(`${unsupported.length} not supported`);
    }
    const excluded = scan.skipped.length - unsupported.length;
    if (excluded > 0) {
      notes.push(`${excluded} excluded by your settings`);
    }
    const detail = notes.length > 0 ? ` (${notes.join(", ")})` : "";
    lines.push(
      `Gateway reports ${count(scan.total, "device")}${detail}, exposing ${exposed} to HomeKit${colon}`,
    );
  } else {
    lines.push(`Exposing ${exposed} to HomeKit${colon}`);
  }

  const typeWidth = Math.max(0, ...rows.map(({ type }) => type.length));
  const nameWidth = Math.max(0, ...rows.map(({ name }) => name.length));
  for (const { type, name, deviceId, status } of rows) {
    lines.push(
      `  ${styleKeyword(type.padEnd(typeWidth))}  ${name.padEnd(nameWidth)}  id ${styleNumber(deviceId)}${statusMarker(status)}`,
    );
  }

  for (const { name, firstUsage, deviceId } of unsupported) {
    lines.push(
      `Not exposed: ${name} (${firstUsage}, id ${styleNumber(deviceId)}), this type of device is not supported yet`,
    );
  }
  return lines;
};

/**
 * The closing line: how many accessories are live, and what changed.
 *
 * An unchanged home reads "all up to date" rather than a row of zeros, so a
 * restart that changed something stands out from one that did not.
 */
export const readyLine = (ready: number, rows: StartupRow[], removed: number): string => {
  const created = rows.filter(({ status }) => status === "new").length;
  const recreated = rows.filter(({ status }) => status === "recreated").length;
  const known = rows.filter(({ status }) => status === "known").length;
  const changes = [
    created > 0 ? `${created} new` : "",
    recreated > 0 ? `${recreated} recreated` : "",
    removed > 0 ? `${removed} removed` : "",
  ].filter(Boolean);
  const accessories = count(ready, "accessory", "accessories");
  if (changes.length === 0) {
    return `Ready: ${accessories}, all up to date`;
  }
  if (known > 0) {
    changes.push(`${known} up to date`);
  }
  return `Ready: ${accessories} (${changes.join(", ")})`;
};
