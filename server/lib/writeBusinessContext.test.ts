import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBusinessContext } from "./writeBusinessContext.js";
import { MAX_PROSE_FIELD_BYTES } from "./context.js";

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "genug-write-business-context-"));
}

test("writes the text to about.md in the given directory", () => {
  const dir = emptyDir();
  assert.deepEqual(writeBusinessContext("We sell handmade pottery.", dir), {
    ok: true,
  });
  assert.equal(
    readFileSync(join(dir, "about.md"), "utf8"),
    "We sell handmade pottery.",
  );
});

test("overwrites whatever was there before", () => {
  const dir = emptyDir();
  writeBusinessContext("First version.", dir);
  writeBusinessContext("Second version.", dir);
  assert.equal(readFileSync(join(dir, "about.md"), "utf8"), "Second version.");
});

test("creates the directory if it does not exist yet", () => {
  const dir = join(emptyDir(), "not-yet-created");
  assert.deepEqual(writeBusinessContext("About the site.", dir), {
    ok: true,
  });
  assert.equal(readFileSync(join(dir, "about.md"), "utf8"), "About the site.");
});

// Refused, not cut short, as for the ground rules: the owner can shorten
// it.
test("refuses a save over the byte cap and writes nothing", () => {
  const dir = emptyDir();
  const tooBig = "x".repeat(MAX_PROSE_FIELD_BYTES + 1);

  const result = writeBusinessContext(tooBig, dir);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /over the/);
  assert.throws(() => readFileSync(join(dir, "about.md"), "utf8"));
});

// The limit is in bytes, not characters, as for the ground rules.
test("measures the cap in UTF-8 bytes, not characters", () => {
  const dir = emptyDir();
  const text = "€".repeat(MAX_PROSE_FIELD_BYTES / 2);

  const result = writeBusinessContext(text, dir);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /bytes/);
});
