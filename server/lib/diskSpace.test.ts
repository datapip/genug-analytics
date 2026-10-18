import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiskGuard, freeBytes } from "./diskSpace.js";

const FLOOR = 1000;

test("has room above the floor and none below it", () => {
  let free = 5000;
  const guard = createDiskGuard("/data", () => free, FLOOR);
  assert.equal(guard.hasRoom(0), true);

  free = 10;
  assert.equal(guard.hasRoom(60_000), false);

  free = 5000;
  assert.equal(guard.hasRoom(120_000), true, "resumes by itself");
});

// /events asks on every request, but the filesystem is only asked once
// per interval.
test("reuses its answer inside the recheck window", () => {
  let calls = 0;
  const guard = createDiskGuard(
    "/data",
    () => {
      calls++;
      return 10;
    },
    FLOOR,
  );
  guard.hasRoom(0);
  guard.hasRoom(1);
  guard.hasRoom(9_999);
  assert.equal(calls, 1);
  guard.hasRoom(10_000);
  assert.equal(calls, 2);
});

// A filesystem that can't report its free space isn't full; stopping
// collection would lose every event for no reason.
test("an unknown free space never stops collection", () => {
  const guard = createDiskGuard("/data", () => undefined, FLOOR);
  assert.equal(guard.hasRoom(0), true);
});

test("reads a real directory's free space", () => {
  const bytes = freeBytes(".");
  assert.ok(bytes === undefined || bytes > 0);
  assert.equal(freeBytes("/no/such/directory/anywhere"), undefined);
});
