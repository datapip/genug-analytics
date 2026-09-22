import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, newestTag } from "./updateCheck.js";
import { parseUpdateCheckEnabled } from "./env.js";

test("parseVersion reads a release tag's three numbers", () => {
  assert.deepEqual(parseVersion("v0.6.0"), [0, 6, 0]);
});

// "dev" (a clone with no tag, see lib/version.ts) and anything else
// that isn't exactly vX.Y.Z has nothing to compare against.
test("parseVersion returns null for a build with no comparable version", () => {
  assert.equal(parseVersion("dev"), null);
  assert.equal(parseVersion("0.6.0"), null);
  assert.equal(parseVersion("v0.6"), null);
});

test("newestTag picks the highest release tag ahead of the current version", () => {
  const tags = ["v0.5.0", "v0.6.0", "v0.7.0"];
  assert.equal(newestTag(tags, [0, 6, 0]), "v0.7.0");
});

test("newestTag ignores tags at or behind the current version", () => {
  assert.equal(newestTag(["v0.6.0", "v0.5.0"], [0, 6, 0]), null);
});

// The repo's tags list can hold anything that isn't a release
// (a branch-shaped or malformed name) — parseVersion filters those
// out rather than newestTag having to know the shape twice.
test("newestTag skips tag names that aren't release versions", () => {
  assert.equal(newestTag(["not-a-version", "v0.6.0"], [0, 6, 0]), null);
});

test("parseUpdateCheckEnabled defaults to true, same as LOCAL_BACKUPS", () => {
  assert.equal(parseUpdateCheckEnabled(undefined), true);
  assert.equal(parseUpdateCheckEnabled("false"), false);
  assert.throws(() => parseUpdateCheckEnabled("nope"));
});
