import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomicWrite.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "genug-atomic-"));
}

test("replaces the file and leaves nothing beside it", () => {
  const dir = scratch();
  const path = join(dir, "page_view.json");
  writeFileSync(path, "old");

  writeFileAtomic(path, "new");

  assert.equal(readFileSync(path, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["page_view.json"]);
});

// The point of it: a write that fails part-way — a full disk is the
// likely cause — must leave the old definition whole. writeFileSync
// alone truncates first, so the same failure would leave an empty file
// the loader skips. A directory in the temporary file's place is a
// failure that is easy to force on every platform.
test("a failed write leaves the old file untouched", () => {
  const dir = scratch();
  const path = join(dir, "page_view.json");
  writeFileSync(path, "old");
  mkdirSync(`${path}.tmp`);

  assert.throws(() => writeFileAtomic(path, "new"));
  assert.equal(readFileSync(path, "utf8"), "old");
});

test("creates a file that did not exist", () => {
  const dir = scratch();
  const path = join(dir, "signup.json");

  writeFileAtomic(path, "{}\n");

  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, "utf8"), "{}\n");
});
