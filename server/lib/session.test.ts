import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSessionId } from "./session.js";

const SITE = "example.com";
const URL_ON_SITE = "https://example.com/pricing";

test("mints a new session when there is no prior event", () => {
  const sessionId = resolveSessionId(undefined, new Date(), SITE);
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId.length > 0);
});

// "A string, non-empty" is also true of a constant, which would put
// every visitor in one session forever.
test("mints a different session for each new visitor", () => {
  const now = new Date();
  assert.notEqual(
    resolveSessionId(undefined, now, SITE),
    resolveSessionId(undefined, now, SITE),
  );
});

test("reuses the session within the 30-minute window", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  const last = {
    sessionId: "existing-session",
    ts: "2026-01-01T11:45:00Z",
    url: URL_ON_SITE,
  };
  assert.equal(resolveSessionId(last, now, SITE), "existing-session");
});

test("reuses the session exactly at the 30-minute boundary", () => {
  const now = new Date("2026-01-01T12:30:00Z");
  const last = {
    sessionId: "existing-session",
    ts: "2026-01-01T12:00:00Z",
    url: URL_ON_SITE,
  };
  assert.equal(resolveSessionId(last, now, SITE), "existing-session");
});

test("mints a new session after 30 minutes of inactivity", () => {
  const now = new Date("2026-01-01T12:31:00Z");
  const last = {
    sessionId: "existing-session",
    ts: "2026-01-01T12:00:00Z",
    url: URL_ON_SITE,
  };
  assert.notEqual(resolveSessionId(last, now, SITE), "existing-session");
});

// A consent cookie is shared by every site on one collector, so the
// visitor_id alone does not end a session at the site boundary.
test("mints a new session when the visitor moves to another site", () => {
  const now = new Date("2026-01-01T12:05:00Z");
  const last = {
    sessionId: "existing-session",
    ts: "2026-01-01T12:00:00Z",
    url: "https://blog.example.com/post",
  };
  assert.notEqual(
    resolveSessionId(last, now, "shop.example.com"),
    "existing-session",
  );
});

// Apex and www are one site, so moving between them is a page view.
test("keeps the session between the apex and www", () => {
  const now = new Date("2026-01-01T12:05:00Z");
  const last = {
    sessionId: "existing-session",
    ts: "2026-01-01T12:00:00Z",
    url: "https://www.example.com/",
  };
  assert.equal(resolveSessionId(last, now, SITE), "existing-session");
});
