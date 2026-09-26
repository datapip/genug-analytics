import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consentlessVisitorId,
  isIssuedVisitorId,
  resolveVisitorIdentity,
} from "./identity.js";
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

// resolveVisitorIdentity decides three things at once — which id, which
// consent_mode the row is stored under, and what happens to the cookie —
// from three inputs that can each be in three states. routes/events.ts
// proves the decisions reach a real response; these prove the decisions
// themselves, including the combinations a request is awkward to force
// into.
const SALT = "resolve-salt";
const IP = "203.0.113.0";
const UA = "Mozilla/5.0";
const hashed = consentlessVisitorId(IP, UA, SALT);
const issuedCookie = consentlessVisitorId("198.51.100.0", UA, SALT);

const resolve = (
  consent: boolean | undefined,
  visitorCookie: string | undefined,
) =>
  resolveVisitorIdentity({
    consent,
    visitorCookie,
    ip: IP,
    userAgent: UA,
    salt: SALT,
  });

test("an explicit no gets the ephemeral hash and asks for no cookie", () => {
  assert.deepEqual(resolve(false, undefined), {
    visitorId: hashed,
    consentful: false,
    cookie: "none",
  });
});

// Withdrawal has to actually remove the identifier (Art. 7(3)), and the
// row it arrives with is consentless even though a valid cookie was sent.
test("an explicit no clears a cookie it refuses to identify by", () => {
  assert.deepEqual(resolve(false, issuedCookie), {
    visitorId: hashed,
    consentful: false,
    cookie: "clear",
  });
});

// Keyed on the raw value rather than the validated one: a cookie this
// server would never trust as an id is still a cookie on the device, and
// leaving it there means the next withdrawal has nothing left to remove.
test("an explicit no clears a cookie value it would not trust", () => {
  assert.equal(resolve(false, "not-a-real-id").cookie, "clear");
});

test("consenting freezes today's hash into a cookie", () => {
  assert.deepEqual(resolve(true, undefined), {
    visitorId: hashed,
    consentful: true,
    cookie: "set",
  });
});

// The race: an automatic page-view that fires before the site's consent
// manager answers sends no consent field, but does carry the visitor's
// real cookie. Treating that as a rejection is what used to lose them.
test("an unanswered request keeps a returning visitor's cookie id", () => {
  assert.deepEqual(resolve(undefined, issuedCookie), {
    visitorId: issuedCookie,
    consentful: true,
    cookie: "set",
  });
});

test("an unanswered request with no cookie stays consentless", () => {
  assert.deepEqual(resolve(undefined, undefined), {
    visitorId: hashed,
    consentful: false,
    cookie: "none",
  });
});

// A cookie outranks even an explicit yes: re-hashing here instead of
// carrying it over would hand a returning, consented visitor a new
// visitor_id at every salt rotation, so one person becomes many and
// every reach number inflates while still reading as plausible. The
// fixture is derived from a different IP than `hashed`, so carrying over
// and re-hashing cannot look the same.
test("an existing cookie wins over an explicit yes", () => {
  assert.deepEqual(resolve(true, issuedCookie), {
    visitorId: issuedCookie,
    consentful: true,
    cookie: "set",
  });
});

// A forged cookie must not become the visitor_id, on any consent path —
// otherwise a client can mint unlimited "visitors" by inventing values.
// Nor may it buy a consentful row: with consent unanswered the forgery
// leaves the visitor exactly where an absent cookie would. With an
// explicit yes it is overwritten with a real id instead.
test("a forged cookie is never adopted as the visitor id", () => {
  const forged = "x".repeat(200);
  assert.deepEqual(resolve(true, forged), {
    visitorId: hashed,
    consentful: true,
    cookie: "set",
  });
  assert.deepEqual(resolve(undefined, forged), {
    visitorId: hashed,
    consentful: false,
    cookie: "none",
  });
});

// Same identity, one consent signal apart: consenting must not mint a new
// id, or every deployment silently orphans its pre-consent events.
test("consenting does not change the id the visitor already had", () => {
  assert.equal(
    resolve(undefined, undefined).visitorId,
    resolve(true, undefined).visitorId,
  );
});
