import { test } from "node:test";
import assert from "node:assert/strict";
import { consentlessVisitorId, isIssuedVisitorId } from "./identity.js";
import { truncateIp } from "./ip.js";

test("consentlessVisitorId is deterministic for the same inputs", () => {
  const salt = "some-salt";
  assert.equal(
    consentlessVisitorId("1.2.3.4", "UA-string", salt),
    consentlessVisitorId("1.2.3.4", "UA-string", salt),
  );
});

test("consentlessVisitorId differs when the IP changes", () => {
  const salt = "some-salt";
  assert.notEqual(
    consentlessVisitorId("1.2.3.4", "UA-string", salt),
    consentlessVisitorId("5.6.7.8", "UA-string", salt),
  );
});

// Drop userAgent from the hash and every other test here still passes,
// while everyone behind one block silently becomes one visitor — and,
// through findLastEventForVisitor, one never-ending session.
test("consentlessVisitorId differs when the User-Agent changes", () => {
  const salt = "some-salt";
  assert.notEqual(
    consentlessVisitorId("1.2.3.4", "Mozilla/5.0 Chrome", salt),
    consentlessVisitorId("1.2.3.4", "Mozilla/5.0 Firefox", salt),
  );
});

test("consentlessVisitorId differs when the salt changes", () => {
  assert.notEqual(
    consentlessVisitorId("1.2.3.4", "UA-string", "salt-a"),
    consentlessVisitorId("1.2.3.4", "UA-string", "salt-b"),
  );
});

test("isIssuedVisitorId accepts a value this server actually minted", () => {
  const minted = consentlessVisitorId("1.2.3.4", "Mozilla/5.0", "some-salt");
  assert.equal(isIssuedVisitorId(minted), true);
});

test("isIssuedVisitorId rejects values a client could make up", () => {
  for (const forged of [
    "", // empty
    "not-a-hash",
    "A".repeat(64), // uppercase — hex digests here are lowercase
    "z".repeat(64), // right length, not hex
    "a".repeat(63), // one short
    "a".repeat(65), // one long
    "x".repeat(5000), // the unbounded-length case
    "abc123; DROP TABLE events",
  ]) {
    assert.equal(isIssuedVisitorId(forged), false, `should reject: ${forged}`);
  }
});

// The whole point: two addresses in one block become one visitor, and
// two blocks stay apart.
test("truncated addresses collide within a block and not across one", () => {
  const salt = "some-salt";
  const id = (ip: string) =>
    consentlessVisitorId(truncateIp(ip), "Mozilla/5.0", salt);

  assert.equal(id("203.0.113.5"), id("203.0.113.200"));
  assert.notEqual(id("203.0.113.5"), id("203.0.114.5"));
  assert.equal(id("2001:db8:1:2::5"), id("2001:db8:1:9::5"));
  assert.notEqual(id("2001:db8:1:2::5"), id("2001:db8:2:2::5"));
});
