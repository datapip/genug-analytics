import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionId } from "./session.js";

test("mints a new session when there is no prior event", () => {
  const sessionId = resolveSessionId(undefined, new Date());
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId.length > 0);
});

// "A string, non-empty" is also true of a constant, which would put
// every visitor in one session forever.
test("mints a different session for each new visitor", () => {
  const now = new Date();
  assert.notEqual(
    resolveSessionId(undefined, now),
    resolveSessionId(undefined, now),
  );
});

test("reuses the session within the 30-minute window", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const last = { sessionId: "existing-session", ts: "2026-01-01T11:45:00Z" };
  assert.equal(resolveSessionId(last, now), "existing-session");
});

test("reuses the session exactly at the 30-minute boundary", () => {
  const now = new Date("2026-01-01T12:30:00Z");
  const last = { sessionId: "existing-session", ts: "2026-01-01T12:00:00Z" };
  assert.equal(resolveSessionId(last, now), "existing-session");
});

test("mints a new session after 30 minutes of inactivity", () => {
  const now = new Date("2026-01-01T12:31:00Z");
  const last = { sessionId: "existing-session", ts: "2026-01-01T12:00:00Z" };
  assert.notEqual(resolveSessionId(last, now), "existing-session");
});
