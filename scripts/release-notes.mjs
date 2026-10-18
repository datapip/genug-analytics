// Prints one version's CHANGELOG.md section as GitHub release notes, so
// the release says the same as the changelog.
//
//   node scripts/release-notes.mjs 0.12.0
//
// The changelog is wrapped at 72 columns for reading in a terminal.
// GitHub renders every newline in a Release body as a line break, so the
// wrapped lines are joined back into one line per bullet or paragraph.
//
// Exits with an error when the version has no section, so CI catches a
// release without a changelog entry.
import { readFileSync } from "node:fs";
import { URL } from "node:url";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version>");
  process.exit(1);
}

const lines = readFileSync(
  new URL("../CHANGELOG.md", import.meta.url),
  "utf8",
).split(/\r?\n/);

const start = lines.findIndex((line) => line.startsWith(`## ${version} `));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## ${version} " section.`);
  process.exit(1);
}
const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
const section = lines.slice(start + 1, next === -1 ? undefined : next);

// Each line either starts a new output line (a bullet, the first line
// after a blank one, anything in a code block) or continues the previous
// one. Blank lines and indentation are kept, so nested lists and code
// blocks stay as written.
const out = [];
let joinable = false;
let inFence = false;
for (const line of section) {
  if (line.trimStart().startsWith("```")) {
    inFence = !inFence;
    out.push(line.trimEnd());
    joinable = false;
  } else if (inFence) {
    out.push(line);
  } else if (line.trim() === "") {
    out.push("");
    joinable = false;
  } else if (joinable && !/^\s*- /.test(line)) {
    out[out.length - 1] += ` ${line.trim()}`;
  } else {
    out.push(line.trimEnd());
    joinable = true;
  }
}

const notes = out.join("\n").trim();
if (notes === "") {
  console.error(`CHANGELOG.md's ${version} section is empty.`);
  process.exit(1);
}
console.log(notes);
