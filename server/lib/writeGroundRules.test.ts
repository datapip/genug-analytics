import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGroundRules } from "./writeGroundRules.js";
import { MAX_PROSE_FIELD_BYTES } from "./context.js";

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "genug-write-ground-rules-"));
}

test("writes the text to ground-rules.md in the given directory", () => {
  const dir = emptyDir();
  assert.deepEqual(writeGroundRules("Only answer in German.", dir), {
    ok: true,
  });
  assert.equal(
    readFileSync(join(dir, "ground-rules.md"), "utf8"),
    "Only answer in German.",
  );
});

test("overwrites whatever was there before", () => {
  const dir = emptyDir();
  writeGroundRules("First version.", dir);
  writeGroundRules("Second version.", dir);
  assert.equal(
    readFileSync(join(dir, "ground-rules.md"), "utf8"),
    "Second version.",
  );
});

test("creates the directory if it does not exist yet", () => {
  const dir = join(emptyDir(), "not-yet-created");
  assert.deepEqual(writeGroundRules("Ground rules.", dir), { ok: true });
  assert.equal(
    readFileSync(join(dir, "ground-rules.md"), "utf8"),
    "Ground rules.",
  );
});

// Refused, not cut short: the owner is at the form and can shorten it.
test("refuses a save over the byte cap and writes nothing", () => {
  const dir = emptyDir();
  const tooBig = "x".repeat(MAX_PROSE_FIELD_BYTES + 1);

  const result = writeGroundRules(tooBig, dir);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /over the/);
  assert.throws(() => readFileSync(join(dir, "ground-rules.md"), "utf8"));
});

// The limit is in bytes, not JavaScript string length; otherwise
// characters of several bytes would let too much text through.
test("measures the cap in UTF-8 bytes, not characters", () => {
  const dir = emptyDir();
  // Each "€" is 3 bytes but 1 character, so this is half the limit in
  // characters but 1.5 times it in bytes.
  const text = "€".repeat(MAX_PROSE_FIELD_BYTES / 2);

  const result = writeGroundRules(text, dir);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /bytes/);
});
