import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consentlessVisitorId,
  isIssuedVisitorId,
  resolveVisitorIdentity,
} from "./identity.js";
import { truncateIp } from "./ip.js";

const SITE = "example.com";

test("consentlessVisitorId is deterministic for the same inputs", () => {
  const salt = "some-salt";
  assert.equal(
    consentlessVisitorId(SITE, "1.2.3.4", "UA-string", salt),
    consentlessVisitorId(SITE, "1.2.3.4", "UA-string", salt),
  );
});

test("consentlessVisitorId differs when the IP changes", () => {
  const salt = "some-salt";
  assert.notEqual(
    consentlessVisitorId(SITE, "1.2.3.4", "UA-string", salt),
    consentlessVisitorId(SITE, "5.6.7.8", "UA-string", salt),
  );
});

// Without the User-Agent in the hash, everyone in one address block
// would be one visitor, with one endless session.
test("consentlessVisitorId differs when the User-Agent changes", () => {
  const salt = "some-salt";
  assert.notEqual(
    consentlessVisitorId(SITE, "1.2.3.4", "Mozilla/5.0 Chrome", salt),
    consentlessVisitorId(SITE, "1.2.3.4", "Mozilla/5.0 Firefox", salt),
  );
});

// Without the site in the hash, one person on two of the installation's
// sites would be one visitor, tracked across sites.
test("consentlessVisitorId differs when the site changes", () => {
  const salt = "some-salt";
  assert.notEqual(
    consentlessVisitorId("example.com", "1.2.3.4", "UA-string", salt),
    consentlessVisitorId("example.org", "1.2.3.4", "UA-string", salt),
  );
});

test("consentlessVisitorId differs when the salt changes", () => {
  assert.notEqual(
    consentlessVisitorId(SITE, "1.2.3.4", "UA-string", "salt-a"),
    consentlessVisitorId(SITE, "1.2.3.4", "UA-string", "salt-b"),
  );
});

test("isIssuedVisitorId accepts a value this server actually minted", () => {
  const minted = consentlessVisitorId(
    SITE,
    "1.2.3.4",
    "Mozilla/5.0",
    "some-salt",
  );
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
    "x".repeat(5000), // very long
    "abc123; DROP TABLE events",
  ]) {
    assert.equal(isIssuedVisitorId(forged), false, `should reject: ${forged}`);
  }
});

// Two addresses in one block are one visitor; two blocks stay apart.
test("truncated addresses collide within a block and not across one", () => {
  const salt = "some-salt";
  const id = (ip: string) =>
    consentlessVisitorId(SITE, truncateIp(ip), "Mozilla/5.0", salt);

  assert.equal(id("203.0.113.5"), id("203.0.113.200"));
  assert.notEqual(id("203.0.113.5"), id("203.0.114.5"));
  assert.equal(id("2001:db8:1:2::5"), id("2001:db8:1:9::5"));
  assert.notEqual(id("2001:db8:1:2::5"), id("2001:db8:2:2::5"));
});

// resolveVisitorIdentity decides three things (the id, the consent mode
// and what happens to the cookie) from inputs with three states each.
// routes/events.test.ts checks the real responses; these check the
// decisions, including combinations that are hard to produce there.
const SALT = "resolve-salt";
const IP = "203.0.113.0";
const UA = "Mozilla/5.0";
const hashed = consentlessVisitorId(SITE, IP, UA, SALT);
const issuedCookie = consentlessVisitorId(SITE, "198.51.100.0", UA, SALT);

const resolve = (
  consent: boolean | undefined,
  visitorCookie: string | undefined,
) =>
  resolveVisitorIdentity({
    consent,
    visitorCookie,
    site: SITE,
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

// Withdrawing consent deletes the cookie (GDPR Art. 7(3)), and the row
// is stored without consent although a valid cookie was sent.
test("an explicit no clears a cookie it refuses to identify by", () => {
  assert.deepEqual(resolve(false, issuedCookie), {
    visitorId: hashed,
    consentful: false,
    cookie: "clear",
  });
});

// Deleted even when invalid: it is still a cookie on the device.
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

// An automatic page view sent before the consent banner answers has no
// consent field but carries the visitor's cookie. The cookie is used but
// not set again: setting it extends its 13 months, and this request
// didn't consent to that.
test("an unanswered request keeps a returning visitor's cookie id", () => {
  assert.deepEqual(resolve(undefined, issuedCookie), {
    visitorId: issuedCookie,
    consentful: true,
    cookie: "none",
  });
});

test("an unanswered request with no cookie stays consentless", () => {
  assert.deepEqual(resolve(undefined, undefined), {
    visitorId: hashed,
    consentful: false,
    cookie: "none",
  });
});

// An existing cookie is kept even on an explicit yes. Hashing again
// would give a returning visitor a new id every day. The cookie comes
// from a different IP than `hashed`, so the two results differ.
test("an existing cookie wins over an explicit yes", () => {
  assert.deepEqual(resolve(true, issuedCookie), {
    visitorId: issuedCookie,
    consentful: true,
    cookie: "set",
  });
});

// A forged cookie never becomes the visitor_id, or a client could create
// unlimited fake visitors. Without an answer it is treated as no cookie;
// with an explicit yes it is replaced by a real id.
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

// Giving consent must not create a new id, or the visitor's earlier
// events that day would belong to someone else.
test("consenting does not change the id the visitor already had", () => {
  assert.equal(
    resolve(undefined, undefined).visitorId,
    resolve(true, undefined).visitorId,
  );
});
