// Prints one version's CHANGELOG.md section as GitHub Release notes, so
// the Release a watcher is notified about says the same thing as the
// changelog rather than a second, hand-written summary of it.
//
//   node scripts/release-notes.mjs 0.12.0
//
// The changelog is wrapped at 72 columns for reading in a terminal.
// GitHub renders every newline in a Release body as a line break, so the
// wrapped lines are joined back into one line per bullet or paragraph.
//
// Exits non-zero when the version has no section: a tag without a
// changelog entry is a release nobody can read about, and CI saying so
// is how that gets noticed.
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

// Each source line either starts a new output line (a bullet, the first
// line after a blank one, anything inside a code block) or continues the
// one before it. Blank lines and indentation are kept, so nested lists
// and code blocks come out as they were written.
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
