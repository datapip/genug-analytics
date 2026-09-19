import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// The route reads ALLOWED_ORIGIN/SALT_SECRET through requireEnv at
// module scope, and db/index.ts opens the database on import — so env
// has to be in place before either module is loaded, which is why these
// are dynamic imports rather than ordinary ones at the top of the file.
const tmpDir = mkdtempSync(join(tmpdir(), "genug-events-"));
process.env.DB_PATH = join(tmpDir, "test.db");
process.env.ALLOWED_ORIGIN = "https://site.example, https://www.site.example";
process.env.SALT_SECRET = "test-salt-secret";

const { eventsRouter } = await import("./events.js");
const { db } = await import("../db/index.js");

const app = express();
app.use("/events", eventsRouter);
const server = app.listen(0);
const { port } = server.address() as AddressInfo;

after(() => {
  server.close();
  // Close before removing: the handle keeps the file open, and Windows
  // refuses to delete a directory that still has one (see the same
  // ordering rule in integration/wiring.test.ts).
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface EventRow {
  event: string;
  visitor_id: string;
  session_id: string;
  ts: string;
  url: string;
  referrer: string | null;
  device_type: string | null;
  browser: string | null;
  visitor_language: string | null;
  consent_mode: string;
}

// A distinct User-Agent per test keeps each one on its own derived
// visitor_id, since the hash is over IP + UA and every request here
// comes from the same loopback address.
async function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://localhost:${port}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// The rows a test wrote. The User-Agent is not stored (only what it
// classifies to is), so rows cannot be told apart by it any more; they
// are told apart by when they were written instead. node:test runs the
// tests in this file one after another, so everything past the id
// watermark taken before a test began is that test's own.
let lastIdBeforeTest = 0;
beforeEach(() => {
  lastIdBeforeTest = (
    db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as {
      id: number;
    }
  ).id;
});

function newRows(): EventRow[] {
  return db
    .prepare("SELECT * FROM events WHERE id > ? ORDER BY id")
    .all(lastIdBeforeTest) as EventRow[];
}

test("stores what the User-Agent classifies to, never the header itself", async () => {
  // A real browser string, not one of the "test-..." names the other
  // tests use: those classify to "Other"/"other", which is also what an
  // empty column reads back as, so they could not tell "classified"
  // from "stored nothing".
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 204);
  const [row] = newRows();
  assert.equal(row!.device_type, "desktop");
  assert.equal(row!.browser, "Chrome");
  // Under any column name: the header is read for the bot check and
  // the hash, and goes no further than the request.
  assert.ok(!JSON.stringify(row).includes(ua));
});

// The Accept-Language header is visitor-written text read back by
// get_top_languages and usable as a segment condition, so only a
// locale-shaped token is stored — the header was the one envelope field
// with no cap at all.
test("stores only a locale-shaped Accept-Language token", async () => {
  const body = {
    event: "page_view",
    url: "https://site.example/",
    props: { page_title: "Home", document_language: "en" },
  };
  await post(body, {
    "user-agent": "test-lang-1",
    "accept-language": "de-DE,de;q=0.9",
  });
  await post(body, {
    "user-agent": "test-lang-2",
    "accept-language": "x".repeat(300),
  });
  await post(body, {
    "user-agent": "test-lang-3",
    "accept-language": "en_US; drop",
  });

  assert.deepEqual(
    newRows().map((row) => row.visitor_language),
    ["de-DE", null, null],
  );
});

const HEX_64 = /^[0-9a-f]{64}$/;

function rejectedCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM rejected_events").get() as {
      n: number;
    }
  ).n;
}

// The top-line invariant in AGENTS.md: identity and time are the
// server's to assign. A client that sends them anyway must not be able
// to choose its own visitor, session, or timestamp — otherwise anyone
// can forge history or impersonate a visitor by POSTing a chosen id.
test("assigns visitor_id, session_id and ts itself, ignoring the client's", async () => {
  const ua = "test-assign";
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
      visitor_id: "client-chosen-visitor",
      session_id: "client-chosen-session",
      ts: "1999-01-01T00:00:00.000Z",
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 204);
  const rows = newRows();
  assert.equal(rows.length, 1);

  const row = rows[0]!;
  assert.match(row.visitor_id, HEX_64);
  assert.notEqual(row.visitor_id, "client-chosen-visitor");
  assert.notEqual(row.session_id, "client-chosen-session");
  assert.notEqual(row.ts, "1999-01-01T00:00:00.000Z");
  assert.ok(Date.now() - new Date(row.ts).getTime() < 60_000);
  assert.equal(row.consent_mode, "consentless");
  assert.equal(res.headers.get("set-cookie"), null);
});

// The consentless → consentful transition freezes the hash this visitor
// already had rather than minting a fresh UUID, which is what merges
// their earlier same-day history for free. Swap it for randomUUID() and
// every deployment silently orphans pre-consent events — with nothing
// on the row to show it happened.
test("freezes the existing consentless hash into the cookie on consent", async () => {
  const ua = "test-merge";
  await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  const res = await post(
    {
      event: "page_view",
      consent: true,
      url: "https://site.example/pricing",
      props: { page_title: "Pricing", document_language: "en" },
    },
    { "user-agent": ua },
  );

  const rows = newRows();
  assert.equal(rows.length, 2);
  assert.equal(
    rows[1]!.visitor_id,
    rows[0]!.visitor_id,
    "consenting must keep the id the visitor already had, not mint a new one",
  );
  assert.equal(rows[0]!.consent_mode, "consentless");
  assert.equal(rows[1]!.consent_mode, "consentful");

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie?.includes(`genug_vid=${rows[0]!.visitor_id}`));
  assert.match(setCookie!, /HttpOnly/i);
  assert.match(setCookie!, /Secure/i);

  // Because the id doesn't change, the session carries through the
  // transition uninterrupted rather than splitting in two.
  assert.equal(rows[1]!.session_id, rows[0]!.session_id);
});

// isIssuedVisitorId is unit-tested on its own; this pins that it is
// actually applied to the incoming cookie. Without it, anyone can mint
// unlimited distinct "visitors" by sending a different value per
// request, at whatever string length they like.
test("ignores a cookie this server never issued", async () => {
  const ua = "test-forged";
  await post(
    {
      event: "page_view",
      consent: true,
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua, cookie: "other=1; genug_vid=not-a-real-id; last=2" },
  );

  const rows = newRows();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]!.visitor_id, "not-a-real-id");
  assert.match(rows[0]!.visitor_id, HEX_64);
});

// Multi-cookie header parsing, with a well-formed forgery sitting
// between two unrelated cookies — the shape a real site's Cookie header
// actually has. A 64-hex value is the one case isIssuedVisitorId can't
// distinguish from a real id, so this documents that it is accepted.
test("reads genug_vid out of a header with other cookies around it", async () => {
  const ua = "test-cookie-parse";
  const forged = "a".repeat(64);
  await post(
    {
      event: "page_view",
      consent: true,
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua, cookie: `_ga=GA1.1.x; genug_vid=${forged}; tz=CET` },
  );

  const rows = newRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.visitor_id, forged);
});

test("rejects props that don't match the event's schema, and logs why", async () => {
  const ua = "test-bad-props";
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: 42, document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 400);
  assert.equal(newRows().length, 0, "a rejected request must store no event");

  const rejected = db
    .prepare(
      "SELECT reason, event, detail FROM rejected_events WHERE event = 'page_view' AND reason = 'invalid_props'",
    )
    .all() as { reason: string; event: string; detail: string }[];
  assert.equal(rejected.length, 1);
  // Not just that page_title was named, but that the actual Zod message —
  // read back verbatim by get_top_rejected_events — survives formatZodError
  // intact. A change that swaps in a vaguer message, or truncates earlier
  // than MAX_DETAIL_LENGTH, would still pass a bare /page_title/ match.
  assert.equal(
    rejected[0]!.detail,
    "page_title: Invalid input: expected string, received number",
  );
});

test("rejects an unregistered event type", async () => {
  const ua = "test-unknown";
  const res = await post(
    // props is required by the envelope even for an event that declares
    // none, so it has to be present here or this is rejected one step
    // earlier as invalid_envelope instead.
    { event: "produt_added_to_cart", url: "https://site.example/", props: {} },
    { "user-agent": ua },
  );

  assert.equal(res.status, 400);
  assert.equal(newRows().length, 0);

  const rejected = db
    .prepare(
      "SELECT event FROM rejected_events WHERE reason = 'unknown_event_type'",
    )
    .all() as { event: string }[];
  assert.deepEqual(
    rejected.map((r) => r.event),
    ["produt_added_to_cart"],
  );
});

// Every registered event and prop name is enforced lowercase, so a
// stray-case call is a typo, not a second name — folding both to
// lowercase before lookup means it still resolves instead of landing in
// rejected_events over nothing but casing.
test("matches an event name and prop keys regardless of case", async () => {
  const ua = "test-case-fold";
  const res = await post(
    {
      event: "Page_View",
      url: "https://site.example/",
      props: { Page_Title: "Home", Document_Language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 204);
  const rows = newRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event, "page_view");
});

// Silently, with the same 204 a real event gets: a false positive must
// not tell the client anything is wrong. The drop is visible to the
// deployer through get_bot_activity instead.
test("drops a bot's request with the same 204 a real event gets", async () => {
  const ua = "Googlebot/2.1 (+http://www.google.com/bot.html)";
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 204);
  assert.equal(newRows().length, 0);
});

// Single known origin only — never reflected. A wildcard here would let
// any site on the internet POST events into this deployment from a
// visitor's browser.
// /events is public, so the client script stripping these before it
// sends is not enough on its own — anything POSTing directly arrives
// with whatever query string it likes.
test("strips non-campaign query parameters from url and referrer", async () => {
  const ua = "test-strip-params";
  await post(
    {
      event: "page_view",
      url: "https://site.example/reset?token=secret123&utm_source=news",
      referrer: "https://site.example/inbox?email=a%40b.com",
      props: { page_title: "Reset", document_language: "en" },
    },
    { "user-agent": ua },
  );

  const [row] = newRows();

  assert.equal(row!.url, "https://site.example/reset?utm_source=news");
  assert.equal(row!.referrer, "https://site.example/inbox");
});

test("returns CORS headers only for configured origins", async () => {
  const allowed = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": "test-cors-ok", origin: "https://site.example" },
  );
  assert.equal(
    allowed.headers.get("access-control-allow-origin"),
    "https://site.example",
  );

  const other = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": "test-cors-bad", origin: "https://evil.example" },
  );
  assert.equal(other.headers.get("access-control-allow-origin"), null);

  // A second configured origin — one site serving on both an apex and a
  // `www.` host, or a staging host reporting to the same collector. The
  // header echoes the origin that actually asked, not a fixed value.
  const second = await post(
    {
      event: "page_view",
      url: "https://www.site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": "test-cors-second", origin: "https://www.site.example" },
  );
  assert.equal(
    second.headers.get("access-control-allow-origin"),
    "https://www.site.example",
  );
  assert.equal(second.headers.get("vary"), "Origin");
});

// The beacon sends application/json, which browsers don't safelist, so
// every single event is preceded by a preflight. Without a Max-Age the
// default cache is ~5 seconds and a visitor pays two round trips per
// event rather than one.
test("answers a preflight with the methods, headers and a cache lifetime", async () => {
  const res = await fetch(`http://localhost:${port}/events`, {
    method: "OPTIONS",
    headers: {
      origin: "https://site.example",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  assert.equal(res.status, 204);
  assert.equal(
    res.headers.get("access-control-allow-origin"),
    "https://site.example",
  );
  assert.equal(res.headers.get("access-control-allow-methods"), "POST");
  assert.equal(res.headers.get("access-control-allow-headers"), "Content-Type");
  assert.equal(res.headers.get("access-control-max-age"), "86400");
});

// Withdrawal has to remove the identifier, not just stop using it: the
// cookie is httpOnly, so the tracked site's own JavaScript cannot
// delete it and only this response can (Art. 7(3) — withdrawing must be
// as easy as consenting). This is about an explicit consent: false —
// see the next test for why omitting the field entirely must not do
// the same thing.
test("clears the visitor cookie when consent is explicitly withdrawn", async () => {
  const ua = "test-withdraw";
  const consented = await post(
    {
      event: "page_view",
      consent: true,
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );
  const issued = consented.headers
    .get("set-cookie")!
    .match(/genug_vid=([0-9a-f]{64})/)![1]!;

  const withdrawn = await post(
    {
      event: "page_view",
      consent: false,
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua, cookie: `genug_vid=${issued}` },
  );

  const setCookie = withdrawn.headers.get("set-cookie");
  assert.ok(setCookie, "withdrawing must send a Set-Cookie that clears it");
  assert.match(setCookie, /genug_vid=;/);
  assert.match(setCookie, /Expires=Thu, 01 Jan 1970/i);
});

// The race this exists to close: a returning, already-consented
// visitor's automatic page-view can fire before their site's consent
// manager confirms consent on that particular request — sending no
// consent field at all, while still carrying the visitor's real
// cookie. That must not be treated as a rejection: consent omitted is
// a real third state, distinct from an explicit false, and a cookie
// already on the request wins regardless.
test("keeps recognising a returning visitor when consent hasn't been answered yet", async () => {
  const ua = "test-unanswered";
  const consented = await post(
    {
      event: "page_view",
      consent: true,
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );
  const issued = consented.headers
    .get("set-cookie")!
    .match(/genug_vid=([0-9a-f]{64})/)![1]!;

  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/pricing",
      props: { page_title: "Pricing", document_language: "en" },
    },
    { "user-agent": ua, cookie: `genug_vid=${issued}` },
  );

  const rows = newRows();
  assert.equal(rows.length, 2);
  assert.equal(
    rows[1]!.visitor_id,
    issued,
    "an unanswered request must not lose the visitor's real cookie-based id",
  );
  assert.equal(
    rows[1]!.consent_mode,
    "consentful",
    "identified via a real persistent cookie, so this row is consentful even though this request didn't itself confirm consent",
  );

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "the cookie is refreshed, not cleared");
  assert.match(setCookie, new RegExp(`genug_vid=${issued};`));
  assert.match(setCookie, /Max-Age=/, "a refresh, not a clear");
  assert.doesNotMatch(setCookie, /Expires=Thu, 01 Jan 1970/i);
});

// A visitor who never consented sends no cookie, so there is nothing to
// clear — and a Set-Cookie header on every consentless event would be
// pure noise on the overwhelmingly common path.
test("sends no cookie header when the request carried none", async () => {
  const ua = "test-no-cookie";
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.headers.get("set-cookie"), null);
});

// --- roles instead of names -----------------------------------------

// The client sends a role for the three events it fires itself, and the
// server decides the name. That is what lets a deployment rename one of
// them without a cached copy of client.js going on sending a name the
// registry no longer has.
test("resolves a role to the event this deployment registers", async () => {
  const ua = "test-role-pageview";
  const res = await post(
    {
      auto: "pageView",
      url: "https://site.example/pricing",
      props: { page_title: "Pricing", document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 204);
  const rows = newRows();
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0]!.event,
    "page_view",
    "the stored name comes from the registry, not the wire",
  );
});

test("resolves the outbound-click and file-download roles too", async () => {
  const ua = "test-role-links";
  await post(
    {
      auto: "outboundClick",
      url: "https://site.example/",
      props: {
        target_url: "https://partner.example/x",
        target_host: "partner.example",
        link_text: "x",
      },
    },
    { "user-agent": ua },
  );
  await post(
    {
      auto: "fileDownload",
      url: "https://site.example/",
      props: {
        file_url: "https://site.example/a.pdf",
        file_extension: "pdf",
        link_text: "a",
      },
    },
    { "user-agent": ua },
  );

  assert.deepEqual(
    newRows().map((row) => row.event),
    ["outbound_link_click", "file_download"],
  );
});

// Props are still checked against the resolved event's own schema —
// resolving a role is not a way past validation.
test("a role's props are validated like any other event's", async () => {
  const ua = "test-role-props";
  const res = await post(
    { auto: "pageView", url: "https://site.example/", props: {} },
    { "user-agent": ua },
  );

  assert.equal(res.status, 400);
  assert.deepEqual(newRows(), []);
  const rejected = db
    .prepare(
      "SELECT event, reason FROM rejected_events ORDER BY id DESC LIMIT 1",
    )
    .get() as { event: string; reason: string };
  assert.equal(rejected.reason, "invalid_props");
  assert.equal(
    rejected.event,
    "page_view",
    "recorded under the resolved name, so it is findable",
  );
});

test("rejects an unknown role, and a body carrying both a role and a name", async () => {
  const ua = "test-role-bad";
  for (const body of [
    { auto: "internalClick", url: "https://site.example/", props: {} },
    {
      auto: "pageView",
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "x", document_language: "en" },
    },
    { url: "https://site.example/", props: {} },
  ]) {
    const res = await post(body, { "user-agent": ua });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(newRows(), []);
});

// An opt-out is the one request that is not an event. It exists so the
// identifier can leave the device — the cookie is httpOnly, so nothing
// on the tracked site can delete it — and it must never become a row.
test("an opt-out clears the visitor cookie and stores nothing", async () => {
  const ua = "test-optout";
  const before = rejectedCount();

  const res = await post(
    { optOut: true },
    { "user-agent": ua, cookie: `genug_vid=${"a".repeat(64)}` },
  );

  assert.equal(res.status, 204);
  assert.equal(newRows().length, 0, "an opt-out is not an event");
  assert.equal(rejectedCount(), before, "and not a rejected one either");

  const cleared = res.headers.get("set-cookie");
  assert.ok(
    cleared?.includes("genug_vid=;"),
    `expected a cleared cookie, got ${cleared}`,
  );
});

test("an opt-out from a visitor who had no cookie is still accepted", async () => {
  const res = await post({ optOut: true }, { "user-agent": "test-optout-new" });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("set-cookie"), null, "nothing to clear");
});

// The short-circuit runs before the envelope is parsed, so it has to be
// impossible to smuggle an event past it by adding the flag.
test("an event body carrying optOut is recorded as an event, not an opt-out", async () => {
  const ua = "test-optout-smuggle";
  const res = await post(
    {
      optOut: true,
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  // The envelope ignores keys it does not know, so this is recorded as
  // the ordinary event it is. What matters is the direction: an event
  // cannot smuggle an opt-out past the check and clear a cookie, which
  // is what the strict schema on the short-circuit buys.
  assert.equal(res.status, 204);
  assert.equal(newRows().length, 1);
  assert.equal(
    res.headers.get("set-cookie"),
    null,
    "an event body must not clear the visitor cookie",
  );
});
