// Prints the CHANGELOG.md section of one version, ready to be used as the
// description of a GitHub release:
//
//   node scripts/changelog-section.mjs 1.0.18 [CHANGELOG.md]
//
// Homebridge UI shows that description as the release notes when a plugin is
// updated (see RELEASING.md).

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CODE_FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}[ \t]/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])[ \t]/;
const SECTION_START = /^#{1,2}[ \t]/;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Matches `## 1.0.18`, `## v1.0.18`, `## [1.0.18] - 2026-10-04` and
// `## 1.0.18 (2026-10-04)`, but neither `## 1.0.180` nor `## 1.0.18-beta.1`.
const versionHeading = (version) =>
  new RegExp(`^##[ \\t]+\\[?v?${escapeRegExp(version)}\\]?(?![\\w.+-])`);

/**
 * Returns the body of the `## <version>` section of a changelog, without its
 * heading.
 *
 * A bullet wrapped over several lines is joined back onto one line: GitHub
 * keeps every line break of a release description, so the wrapped lines would
 * show as a ragged list.
 *
 * @param {string} changelog Content of CHANGELOG.md.
 * @param {string} version Version of the release, for example `1.0.18`.
 * @returns {string} The trimmed section.
 */
export function changelogSection(changelog, version) {
  const wanted = version.replace(/^v/, "");
  const heading = versionHeading(wanted);
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "## ${wanted}" section.`);
  }

  const section = [];
  let inCodeFence = false;
  for (const rawLine of lines.slice(start + 1)) {
    const line = rawLine.trimEnd();
    const isFence = CODE_FENCE.test(line);
    if (!inCodeFence && !isFence && SECTION_START.test(line)) {
      break;
    }
    const previous = section.at(-1);
    const wrapsPrevious =
      !inCodeFence &&
      !isFence &&
      previous !== undefined &&
      previous !== "" &&
      !HEADING.test(previous) &&
      !CODE_FENCE.test(previous) &&
      /^\s+\S/.test(line) &&
      !LIST_ITEM.test(line);
    if (wrapsPrevious) {
      section[section.length - 1] = `${previous} ${line.trim()}`;
    } else {
      section.push(line);
    }
    if (isFence) {
      inCodeFence = !inCodeFence;
    }
  }

  const notes = section.join("\n").trim();
  if (notes === "") {
    throw new Error(`The "## ${wanted}" section of CHANGELOG.md is empty.`);
  }
  return notes;
}

function main([version, file = "CHANGELOG.md"]) {
  if (!version) {
    console.error("Usage: node scripts/changelog-section.mjs <version> [CHANGELOG.md]");
    return 2;
  }
  try {
    process.stdout.write(`${changelogSection(readFileSync(file, "utf8"), version)}\n`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
