import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessionSalt } from "./cockpitSessionSalt.js";

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "genug-session-salt-")), "salt");
}

// A salt that changed on every start would sign the owner out on every
// deploy, so the second start must read back what the first wrote.
test("the salt made on the first start is the one read on the next", () => {
  const path = tempPath();

  const first = loadSessionSalt(path);
  const second = loadSessionSalt(path);

  assert.equal(first.length, 16);
  assert.deepEqual(second, first);
});

test("two installs get two salts", () => {
  assert.notDeepEqual(loadSessionSalt(tempPath()), loadSessionSalt(tempPath()));
});

test("a file that is not a salt is replaced rather than used", () => {
  const path = tempPath();
  writeFileSync(path, "not a salt");

  const salt = loadSessionSalt(path);

  assert.equal(salt.length, 16);
  assert.equal(readFileSync(path, "utf8").trim(), salt.toString("hex"));
});

// The cockpit must still start: a salt it cannot keep only means the
// next restart signs everyone out.
test("a salt that cannot be stored is still returned", () => {
  const path = tempPath();
  mkdirSync(`${path}.tmp`);

  assert.equal(loadSessionSalt(path).length, 16);
});

test(
  "the stored salt is readable by its owner only",
  { skip: process.platform === "win32" && "no POSIX permissions on Windows" },
  () => {
    const path = tempPath();
    loadSessionSalt(path);

    assert.equal(statSync(path).mode & 0o777, 0o600);
  },
);
