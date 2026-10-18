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

// A failed write (most likely a full disk) must leave the old file
// unchanged. A folder where the temporary file should go makes the write
// fail on every platform.
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
