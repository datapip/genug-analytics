import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  seedContextFiles,
  readDeploymentContext,
  readGroundRulesRaw,
  readBusinessContextRaw,
  MAX_PROSE_FIELD_BYTES,
} from "./context.js";

// Real folders, not a fake filesystem; both functions take the folder
// as a parameter so each test can use its own.
function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "genug-context-"));
}

function seeded(): string {
  const dir = emptyDir();
  assert.deepEqual(seedContextFiles(dir), {
    ok: true,
    created: ["ground-rules.md", "history.json"],
  });
  return dir;
}

test("seeding writes the shipped default the first time", () => {
  const dir = seeded();
  const written = readFileSync(join(dir, "ground-rules.md"), "utf8");
  assert.match(written, /Ask rather than guess/);
  // Created as an empty list, so the owner has a file to find.
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "history.json"), "utf8")),
    [],
  );
});

// Seeding runs on every start, and the owner's edited files must not be
// overwritten.
test("seeding never overwrites files that are already there", () => {
  const dir = seeded();
  writeFileSync(join(dir, "ground-rules.md"), "Only answer in German.");
  writeFileSync(
    join(dir, "history.json"),
    JSON.stringify([{ from: "2026-05-03", note: "Redesign." }]),
  );

  assert.deepEqual(seedContextFiles(dir), { ok: true, created: [] });
  assert.equal(
    readFileSync(join(dir, "ground-rules.md"), "utf8"),
    "Only answer in German.",
  );
  assert.match(readFileSync(join(dir, "history.json"), "utf8"), /Redesign/);
});

test("the document serves the owner's file under a fixed heading", () => {
  const dir = seeded();
  writeFileSync(join(dir, "ground-rules.md"), "Only answer in German.");

  const document = readDeploymentContext(dir);
  assert.match(document, /^# Deployment context/);
  assert.match(document, /## Ground rules\n\nOnly answer in German\./);
  // The owner's file replaces the default, not adds to it; otherwise the
  // agent would get rules the owner removed.
  assert.equal(document.includes("Ask rather than guess"), false);
});

// The agent is told where this text comes from, because it also sees
// visitor text it must not follow.
test("the document says the text is the owner's, not a visitor's", () => {
  assert.match(readDeploymentContext(seeded()), /not by\s+visitors/);
});

test("an empty file is honoured, and said out loud", () => {
  const dir = seeded();
  writeFileSync(join(dir, "ground-rules.md"), "   \n\n");

  const document = readDeploymentContext(dir);
  assert.match(document, /is empty, so no owner-supplied rules are in force/);
  // The defaults must not come back: an empty file means "no rules".
  assert.equal(document.includes("Ask rather than guess"), false);
});

// When the file can't be read, the default is used and the document
// says so, instead of silently giving the agent rules nobody chose.
test("an unreadable file falls back to the built-in and says why", () => {
  const dir = emptyDir();
  // A folder where the file should be: readFileSync throws EISDIR. Works
  // the same on Windows, unlike chmod.
  mkdirSync(join(dir, "ground-rules.md"));

  const document = readDeploymentContext(dir);
  assert.match(document, /could not be read/);
  assert.match(document, /not\*\* being applied/);
  assert.match(document, /Ask rather than guess/);
});

test("a missing file is reported as such, not as an error", () => {
  const document = readDeploymentContext(emptyDir());

  assert.match(document, /There is no file at/);
  assert.match(document, /Ask rather than guess/);
  // "Missing" and "unreadable" get different wording.
  assert.equal(document.includes("could not be read"), false);
});

test("an oversized file is cut, and the cut is named", () => {
  const dir = seeded();
  // 8 KB over the limit, so the numbers in the message can be checked
  // exactly.
  const overBy = 8 * 1024;
  const body = `KEEP THIS FIRST LINE\n${"x".repeat(MAX_PROSE_FIELD_BYTES + overBy)}`;
  writeFileSync(join(dir, "ground-rules.md"), body);

  const document = readDeploymentContext(dir);
  assert.match(document, /\*\*Truncated\.\*\*/);
  assert.match(
    document,
    new RegExp(
      `${overBy + "KEEP THIS FIRST LINE\n".length} bytes were dropped`,
    ),
  );
  // The start of the file is kept.
  assert.match(document, /KEEP THIS FIRST LINE/);
});

// readGroundRulesRaw is for the cockpit editor: it returns only the
// text, without heading or notes, so it can be saved unchanged.
test("raw read returns the owner's file untouched", () => {
  const dir = seeded();
  writeFileSync(join(dir, "ground-rules.md"), "Only answer in German.");

  const result = readGroundRulesRaw(dir);
  assert.deepEqual(result, {
    ok: true,
    text: "Only answer in German.",
    usingDefault: false,
  });
});

test("raw read falls back to the built-in default when there is no file, and says so", () => {
  const result = readGroundRulesRaw(emptyDir());
  assert.equal(result.ok, true);
  assert.equal((result as { usingDefault: boolean }).usingDefault, true);
  assert.match((result as { text: string }).text, /Ask rather than guess/);
});

test("raw read reports an unreadable file as an error rather than falling back silently", () => {
  const dir = emptyDir();
  mkdirSync(join(dir, "ground-rules.md"));

  const result = readGroundRulesRaw(dir);
  assert.equal(result.ok, false);
});

// The business context has no default, so missing and empty both mean
// "not written yet".

test("the document serves the owner's business context under its own heading, after ground rules", () => {
  const dir = seeded();
  writeFileSync(join(dir, "about.md"), "We sell handmade pottery.");

  const document = readDeploymentContext(dir);
  assert.match(document, /## About this site\n\nWe sell handmade pottery\./);
  // Fixed order: Ground rules, About this site, History.
  assert.ok(
    document.indexOf("## Ground rules") <
      document.indexOf("## About this site") &&
      document.indexOf("## About this site") < document.indexOf("## History"),
  );
});

test("an absent business-context file reads as not-yet-configured, not as evidence of anything", () => {
  const document = readDeploymentContext(seeded());
  assert.match(
    document,
    /has not written down what the site is for.*not that the site has no clear purpose/s,
  );
});

test("an empty business-context file reads exactly the same as an absent one", () => {
  const dir = seeded();
  writeFileSync(join(dir, "about.md"), "   \n\n");

  const document = readDeploymentContext(dir);
  assert.match(document, /has not written down what the site is for/);
});

test("an oversized business-context file is cut, and the cut is named", () => {
  const dir = seeded();
  const overBy = 8 * 1024;
  const body = `KEEP THIS FIRST LINE\n${"x".repeat(MAX_PROSE_FIELD_BYTES + overBy)}`;
  writeFileSync(join(dir, "about.md"), body);

  const document = readDeploymentContext(dir);
  assert.match(document, /## About this site[\s\S]*\*\*Truncated\.\*\*/);
  assert.match(document, /KEEP THIS FIRST LINE/);
});

test("an unreadable business-context file is named, not silently ignored", () => {
  const dir = emptyDir();
  mkdirSync(join(dir, "about.md"));

  const document = readDeploymentContext(dir);
  assert.match(document, /## About this site[\s\S]*could not be read/);
});

test("raw business-context read returns the owner's file untouched", () => {
  const dir = seeded();
  writeFileSync(join(dir, "about.md"), "We sell handmade pottery.");

  assert.deepEqual(readBusinessContextRaw(dir), {
    ok: true,
    text: "We sell handmade pottery.",
  });
});

test("raw business-context read returns empty text when there is no file, not a default", () => {
  assert.deepEqual(readBusinessContextRaw(emptyDir()), { ok: true, text: "" });
});

test("raw business-context read reports an unreadable file as an error", () => {
  const dir = emptyDir();
  mkdirSync(join(dir, "about.md"));

  const result = readBusinessContextRaw(dir);
  assert.equal(result.ok, false);
});
