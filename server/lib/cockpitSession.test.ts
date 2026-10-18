import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  SESSION_MAX_AGE_MS,
  deriveSessionKey,
  issueSessionToken,
  verifySessionToken,
} from "./cockpitSession.js";

// scrypt is slow on purpose (see deriveSessionKey), so the keys are
// derived once for the whole file.
const salt = Buffer.alloc(16, 1);
const key = deriveSessionKey("hunter2", salt);
const otherKey = deriveSessionKey("hunter3", salt);

test("a freshly issued token verifies", () => {
  assert.ok(verifySessionToken(issueSessionToken(key), key));
});

test("a token signed with another password does not verify", () => {
  assert.equal(verifySessionToken(issueSessionToken(otherKey), key), undefined);
});

// Because the key comes from the password, changing COCKPIT_PASSWORD
// ends every open session.
test("rotating the password invalidates a session that was already open", () => {
  const openSession = issueSessionToken(key);

  assert.equal(
    verifySessionToken(openSession, deriveSessionKey("a-new-password", salt)),
    undefined,
  );
});

// With its own salt, the same password gives different keys on two
// installations.
test("the same password on another install signs with another key", () => {
  const elsewhere = deriveSessionKey("hunter2", Buffer.alloc(16, 2));

  assert.notDeepEqual(elsewhere, key);
  assert.equal(
    verifySessionToken(issueSessionToken(key), elsewhere),
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

// Checks the exact moment of expiry (expiresAt <= now) from both sides,
// so changing <= to < is caught.
test("a token expires at its own instant, not one tick after", () => {
  const now = Date.now();
  const token = issueSessionToken(key, now - SESSION_MAX_AGE_MS);

  assert.equal(verifySessionToken(token, key, now), undefined);
  assert.ok(verifySessionToken(token, key, now - 1));
});

// The expiry is signed, so the holder of the cookie can't extend it.
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

// The signature covers the expiry text exactly as received, so "0123"
// and "123" are different tokens, even though they are the same number.
test("a signature covers one spelling of the expiry, not the instant", () => {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const padded = `0${expiry}`;
  const signature = createHmac("sha256", key).update(padded).digest("hex");

  assert.ok(verifySessionToken(`${padded}.${signature}`, key));
  assert.equal(verifySessionToken(`${expiry}.${signature}`, key), undefined);
});

// What the sign-out check compares with. Worked out from the expiry, so
// the token only needs two fields.
test("issuedAt is reported as the expiry minus the session length", () => {
  const now = Date.now();
  const session = verifySessionToken(issueSessionToken(key, now), key, now);

  assert.equal(session?.issuedAt, now);
});
