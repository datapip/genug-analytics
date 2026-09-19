import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  SESSION_MAX_AGE_MS,
  deriveSessionKey,
  issueSessionToken,
  verifySessionToken,
} from "./cockpitSession.js";

// scrypt is deliberately slow (that is the point — see the comment on
// deriveSessionKey), so the keys are derived once for the whole file
// rather than per test.
const key = deriveSessionKey("hunter2");
const otherKey = deriveSessionKey("hunter3");

test("a freshly issued token verifies", () => {
  assert.ok(verifySessionToken(issueSessionToken(key), key));
});

test("a token signed with another password does not verify", () => {
  assert.equal(verifySessionToken(issueSessionToken(otherKey), key), undefined);
});

// The property that makes deriving the key from the password worth it:
// changing COCKPIT_PASSWORD ends every session that was open, with no
// session store to clear and no second secret to rotate.
test("rotating the password invalidates a session that was already open", () => {
  const openSession = issueSessionToken(key);

  assert.equal(
    verifySessionToken(openSession, deriveSessionKey("a-new-password")),
    undefined,
  );
});

test("an expired token does not verify", () => {
  const now = Date.now();
  const token = issueSessionToken(key, now - SESSION_MAX_AGE_MS - 1000);

  assert.equal(verifySessionToken(token, key, now), undefined);
});

test("a token one minute from expiry still verifies", () => {
  const now = Date.now();
  const token = issueSessionToken(key, now - SESSION_MAX_AGE_MS + 60_000);

  assert.ok(verifySessionToken(token, key, now));
});

// The exact instant, not just "clearly expired" vs. "clearly valid" —
// expiresAt <= now is what the code checks, so a token expires at its
// own instant rather than one tick after it. Pinned on both sides of
// that instant so a change to <= vs. < is caught either way.
test("a token expires at its own instant, not one tick after", () => {
  const now = Date.now();
  const token = issueSessionToken(key, now - SESSION_MAX_AGE_MS);

  assert.equal(verifySessionToken(token, key, now), undefined);
  assert.ok(verifySessionToken(token, key, now - 1));
});

// The whole reason the expiry is signed. Without the signature check
// this is a cookie whose owner decides when it expires.
test("an expiry edited by hand does not verify", () => {
  const token = issueSessionToken(key);
  const [, signature] = token.split(".");
  const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;

  assert.equal(verifySessionToken(`${farFuture}.${signature}`, key), undefined);
});

test("a tampered signature does not verify", () => {
  const [expiry, signature] = issueSessionToken(key).split(".");
  const flipped = (signature![0] === "a" ? "b" : "a") + signature!.slice(1);

  assert.equal(verifySessionToken(`${expiry}.${flipped}`, key), undefined);
});

test("nonsense in the cookie does not verify", () => {
  for (const token of [
    undefined,
    "",
    ".",
    "no-separator",
    `${Date.now() + 1000}.`,
    `.${"0".repeat(64)}`,
  ]) {
    assert.equal(verifySessionToken(token, key), undefined, `token: ${token}`);
  }
});

// The expiry is signed as the exact string it arrived as, and nothing
// canonicalises it. So each spelling of an instant stands or falls on
// its own signature — which is the point: parsing the number out first
// and signing that back would make "0123" and "123" interchangeable,
// and deciding which one is authoritative is a question worth not
// having at all.
test("a signature covers one spelling of the expiry, not the instant", () => {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const padded = `0${expiry}`;
  const signature = createHmac("sha256", key).update(padded).digest("hex");

  assert.ok(verifySessionToken(`${padded}.${signature}`, key));
  assert.equal(verifySessionToken(`${expiry}.${signature}`, key), undefined);
});

// What the logout check compares against. Derived rather than stored, so
// the token stays two fields.
test("issuedAt is reported as the expiry minus the session length", () => {
  const now = Date.now();
  const session = verifySessionToken(issueSessionToken(key, now), key, now);

  assert.equal(session?.issuedAt, now);
});
