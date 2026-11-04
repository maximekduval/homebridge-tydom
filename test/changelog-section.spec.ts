import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it } from "vitest";

import { changelogSection } from "../scripts/changelog-section.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/changelog-section.mjs", import.meta.url));

const readRepositoryFile = (name: string): string =>
  readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("changelogSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## 2.2.2",
    "",
    "- Name the lock and the phase sensors so Home",
    "  stops showing the accessory name on every tile.",
    "- Keep a rename made in Home.",
    "",
    "## 2.2.1",
    "",
    "- Poll faster when the door locks.",
    "",
  ].join("\n");

  it("returns the section of one version, without its heading", () => {
    expect(changelogSection(changelog, "2.2.2")).toBe(
      [
        "- Name the lock and the phase sensors so Home stops showing the accessory name on every tile.",
        "- Keep a rename made in Home.",
      ].join("\n"),
    );
    expect(changelogSection(changelog, "2.2.1")).toBe("- Poll faster when the door locks.");
  });

  it("joins only the wrapped lines of a list item", () => {
    const notes = [
      "## 1.0.0",
      "",
      "### Added",
      "",
      "- First item, wrapped",
      "  on a second line",
      "  and a third one.",
      "  - A nested item",
      "    that wraps too.",
      "1. A numbered item.",
      "",
      "### Fixed",
      "",
      "A paragraph.",
    ].join("\n");

    expect(changelogSection(notes, "1.0.0")).toBe(
      [
        "### Added",
        "",
        "- First item, wrapped on a second line and a third one.",
        "  - A nested item that wraps too.",
        "1. A numbered item.",
        "",
        "### Fixed",
        "",
        "A paragraph.",
      ].join("\n"),
    );
  });

  it("keeps code blocks as they are", () => {
    const notes = [
      "## 1.0.0",
      "",
      "- Run:",
      "",
      "```sh",
      "npm install",
      "  --flag",
      "## not a heading",
      "```",
      "",
      "- Done.",
      "",
      "## 0.9.0",
      "",
      "- Older.",
    ].join("\n");

    expect(changelogSection(notes, "1.0.0")).toBe(
      [
        "- Run:",
        "",
        "```sh",
        "npm install",
        "  --flag",
        "## not a heading",
        "```",
        "",
        "- Done.",
      ].join("\n"),
    );
  });

  it.each([
    "## 2.2.2",
    "## v2.2.2",
    "## [2.2.2] - 2026-10-04",
    "## 2.2.2 (2026-10-04)",
    "## [2.2.2](https://example.com/compare/v2.2.1...v2.2.2)",
  ])("finds the heading %s", (heading) => {
    expect(changelogSection(`${heading}\n\n- Notes.\n`, "2.2.2")).toBe("- Notes.");
  });

  it.each(["## 2.2.20", "## 2.2.2-beta.1", "## 12.2.2"])(
    "does not mistake %s for 2.2.2",
    (heading) => {
      expect(() => changelogSection(`${heading}\n\n- Notes.\n`, "2.2.2")).toThrow(
        'no "## 2.2.2" section',
      );
    },
  );

  it("accepts Windows line endings and a version with a leading v", () => {
    expect(changelogSection(changelog.replace(/\n/g, "\r\n"), "v2.2.1")).toBe(
      "- Poll faster when the door locks.",
    );
  });

  it("fails when the version has no section or the section is empty", () => {
    expect(() => changelogSection(changelog, "9.9.9")).toThrow('no "## 9.9.9" section');
    expect(() => changelogSection("## 1.0.0\n\n## 0.9.0\n\n- Old.\n", "1.0.0")).toThrow(
      "section of CHANGELOG.md is empty",
    );
  });
});

describe("scripts/changelog-section.mjs", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

  it("prints the notes of a version", () => {
    const { version } = JSON.parse(readRepositoryFile("package.json"));
    const result = run(version);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `${changelogSection(readRepositoryFile("CHANGELOG.md"), version)}\n`,
    );
  });

  it("exits with an error when the version has no notes", () => {
    const result = run("0.0.0");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('no "## 0.0.0" section');
  });

  it("prints its usage without a version", () => {
    const result = run();

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
  });
});

// Homebridge UI shows the notes of a GitHub release when a plugin is updated,
// and the release workflow builds them from CHANGELOG.md (see RELEASING.md).
describe("CHANGELOG.md", () => {
  const changelog = readRepositoryFile("CHANGELOG.md");

  it("has notes for the version in package.json", () => {
    const { version } = JSON.parse(readRepositoryFile("package.json"));

    expect(changelogSection(changelog, version)).toMatch(/\S/);
  });

  it.each([...changelog.matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map((m) => m[1]!))(
    "has notes for %s",
    (version) => {
      expect(changelogSection(changelog, version)).toMatch(/\S/);
    },
  );
});
