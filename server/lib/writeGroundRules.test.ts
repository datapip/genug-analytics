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

// Refused, not truncated: unlike a file that grew stale after the cap
// changed under it, a save from the cockpit has someone right there to
// shorten the text instead.
test("refuses a save over the byte cap and writes nothing", () => {
  const dir = emptyDir();
  const tooBig = "x".repeat(MAX_PROSE_FIELD_BYTES + 1);

  const result = writeGroundRules(tooBig, dir);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /over the/);
  assert.throws(() => readFileSync(join(dir, "ground-rules.md"), "utf8"));
});

// The cap is measured in bytes, not JS string length — a multi-byte
// character would let a save through that the agent's document then
// truncates mid-character at render time.
test("measures the cap in UTF-8 bytes, not characters", () => {
  const dir = emptyDir();
  // Each "€" is 3 bytes but 1 character: half the cap in character
  // count is 1.5x the cap in bytes. A .length check would wrongly let
  // this through; Buffer.byteLength must not.
  const text = "€".repeat(MAX_PROSE_FIELD_BYTES / 2);

  const result = writeGroundRules(text, dir);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /bytes/);
});
