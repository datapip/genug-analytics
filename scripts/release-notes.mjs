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

const blocks = [];
let current;
for (const line of section) {
  if (line.trim() === "") {
    current = undefined;
  } else if (current === undefined || line.startsWith("- ")) {
    current = line.trimEnd();
    blocks.push(current);
  } else {
    blocks[blocks.length - 1] = current = `${current} ${line.trim()}`;
  }
}

if (blocks.length === 0) {
  console.error(`CHANGELOG.md's ${version} section is empty.`);
  process.exit(1);
}

// A blank line between paragraphs and headings, none between bullets of
// one list, as in the source.
let out = "";
blocks.forEach((block, i) => {
  if (i > 0) {
    out +=
      block.startsWith("- ") && blocks[i - 1].startsWith("- ") ? "\n" : "\n\n";
  }
  out += block;
});
console.log(out);
