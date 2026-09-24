import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDailySalt, startRotation } from "./dailySalt.js";

const MONDAY = new Date("2026-09-21T09:00:00Z");
const MONDAY_LATE = new Date("2026-09-21T23:59:00Z");
const TUESDAY = new Date("2026-09-22T00:01:00Z");

function saltPath(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-salt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "daily-salt.json");
}

test("one salt for the whole UTC day", (t) => {
  const salts = createDailySalt(saltPath(t), MONDAY);
  assert.equal(salts.saltFor(MONDAY), salts.saltFor(MONDAY_LATE));
});

// The point of the module: the old salt is not kept anywhere, so a
// past day's hashes cannot be rebuilt.
test("a new day gets a new salt, and the file no longer holds the old one", (t) => {
  const path = saltPath(t);
  const salts = createDailySalt(path, MONDAY);
  const monday = salts.saltFor(MONDAY);
  const tuesday = salts.saltFor(TUESDAY);

  assert.notEqual(monday, tuesday);
  const stored = readFileSync(path, "utf8");
  assert.ok(stored.includes(tuesday));
  assert.ok(!stored.includes(monday));
});

// A deploy during the day must not split every visitor on the site.
test("a restart on the same day keeps the salt", (t) => {
  const path = saltPath(t);
  const before = createDailySalt(path, MONDAY).saltFor(MONDAY);
  const after = createDailySalt(path, MONDAY).saltFor(MONDAY_LATE);
  assert.equal(before, after);
});

test("a restart on a later day does not reuse the stored salt", (t) => {
  const path = saltPath(t);
  const monday = createDailySalt(path, MONDAY).saltFor(MONDAY);
  const tuesday = createDailySalt(path, TUESDAY).saltFor(TUESDAY);
  assert.notEqual(monday, tuesday);
  assert.ok(!readFileSync(path, "utf8").includes(monday));
});

// A server stopped over midnight left yesterday's salt on disk. It goes
// at start, not at the first event.
test("starting on a later day replaces the stored salt before any event", (t) => {
  const path = saltPath(t);
  const monday = createDailySalt(path, MONDAY).saltFor(MONDAY);
  createDailySalt(path, TUESDAY);
  assert.ok(!readFileSync(path, "utf8").includes(monday));
});

// The timer is what makes "replaced at midnight" true on a quiet site.
// Delete it and every other test here still passes.
test("the salt rotates at midnight with no traffic", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: MONDAY_LATE });
  const path = saltPath(t);
  const monday = createDailySalt(path).saltFor(MONDAY_LATE);
  const timer = startRotation(createDailySalt(path));
  t.after(() => clearInterval(timer));

  t.mock.timers.tick(2 * 60_000);

  const stored = readFileSync(path, "utf8");
  assert.ok(!stored.includes(monday));
  assert.match(stored, /"day":"2026-09-22"/);
});

// A full disk must not keep yesterday's salt on the volume: losing the
// file only splits visitors on the next restart.
test("a failed write deletes the old salt instead of leaving it", (t) => {
  const path = saltPath(t);
  const monday = createDailySalt(path, MONDAY).saltFor(MONDAY);
  // A directory where the temp file goes makes the write fail.
  mkdirSync(`${path}.tmp`);

  const salts = createDailySalt(path, TUESDAY);

  assert.match(salts.saltFor(TUESDAY), /^[a-f0-9]{64}$/);
  let stored = "";
  try {
    stored = readFileSync(path, "utf8");
  } catch {
    // Gone is the expected outcome.
  }
  assert.ok(!stored.includes(monday));
});

// Random, not derived: two servers, or one server's two days, never
// share a salt that some secret could reproduce.
test("two stores never produce the same salt", (t) => {
  const a = createDailySalt(saltPath(t), MONDAY).saltFor(MONDAY);
  const b = createDailySalt(saltPath(t), MONDAY).saltFor(MONDAY);
  assert.notEqual(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("a damaged or foreign file is replaced, not trusted or thrown on", (t) => {
  for (const content of [
    "not json",
    '{"day":"2026-09-21"}',
    '{"day":"2026-09-21","salt":"short"}',
    "[]",
  ]) {
    const path = saltPath(t);
    writeFileSync(path, content);
    const salt = createDailySalt(path, MONDAY).saltFor(MONDAY);
    assert.match(salt, /^[a-f0-9]{64}$/, content);
    assert.ok(readFileSync(path, "utf8").includes(salt), content);
  }
});

// Collection must not stop because the salt could not be saved.
test("an unwritable path still gives a salt", () => {
  const salts = createDailySalt(
    "/nonexistent-genug-dir/daily-salt.json",
    MONDAY,
  );
  const salt = salts.saltFor(MONDAY);
  assert.match(salt, /^[a-f0-9]{64}$/);
  assert.equal(salts.saltFor(MONDAY_LATE), salt);
});

test("the file is readable by its owner only", (t) => {
  if (process.platform === "win32") {
    t.skip("Windows has no POSIX file modes");
    return;
  }
  const path = saltPath(t);
  createDailySalt(path, MONDAY).saltFor(MONDAY);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
