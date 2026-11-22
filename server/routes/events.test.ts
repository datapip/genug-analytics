import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { MAX_EVENT_NAME_LENGTH } from "@genug/schema-registry";
import { createEventsRouter } from "./events.js";
import { openDatabase } from "../db/index.js";
import { createDailySalt } from "../lib/dailySalt.js";
import { createDiskGuard } from "../lib/diskSpace.js";
import { botActivityCounter } from "../lib/botActivity.js";

// A real database file, not :memory:, so the connection has the same
// settings as the server's (WAL, secure_delete).
const tmpDir = mkdtempSync(join(tmpdir(), "genug-events-"));
const db = openDatabase(join(tmpDir, "test.db"));

const app = express();
// Lets a test set its address with X-Forwarded-For. Without the header,
// req.ip is the loopback address.
app.set("trust proxy", true);
app.use(
  "/events",
  createEventsRouter({
    db,
    allowedOrigins: new Set([
      "https://site.example",
      "https://www.site.example",
    ]),
    // Three more sites, for the multi-site tests.
    siteHosts: new Set([
      "site.example",
      "other.example",
      "blog.site.example",
      "shop.site.example",
    ]),
    dailySalt: createDailySalt(join(tmpDir, "daily-salt.json"), "UTC"),
    diskGuard: createDiskGuard(tmpDir),
  }),
);
// The same route with the country lookup on. The table is a fake that
// records what it was asked, to check it only gets the shortened
// address.
const askedForCountry: string[] = [];
app.use(
  "/with-country/events",
  createEventsRouter({
    db,
    allowedOrigins: new Set(["https://site.example"]),
    siteHosts: new Set(["site.example"]),
    dailySalt: createDailySalt(join(tmpDir, "daily-salt.json"), "UTC"),
    diskGuard: createDiskGuard(tmpDir),
    countries: {
      lookup(truncated) {
        askedForCountry.push(truncated);
        return truncated === "203.0.113.0" ? "DE" : "ZZ";
      },
    },
  }),
);
const server = app.listen(0);
const { port } = server.address() as AddressInfo;

after(() => {
  server.close();
  // Close before removing: Windows can't delete a folder with an open
  // file (see integration/wiring.test.ts).
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
  country: string | null;
  consent_mode: string;
  props: string;
}

// The newest rejected_events row, for the request a test just sent.
function lastRejection() {
  return db
    .prepare(
      "SELECT reason, event, detail FROM rejected_events ORDER BY id DESC LIMIT 1",
    )
    .get() as { reason: string; event: string | null; detail: string | null };
}

// A different User-Agent per test gives each test its own visitor_id,
// since every request comes from the same address.
async function post(
  body: unknown,
  headers: Record<string, string> = {},
  path = "/events",
): Promise<Response> {
  return fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// The rows a test wrote. The User-Agent isn't stored, so rows are found
// by id instead: the tests in this file run one after another, so every
// row after the highest id seen before a test started is that test's.
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
  // A real browser string: the "test-..." names other tests use become
  // "Other"/"other", which an empty column would also read as.
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
  // In no column at all: the header is only used during the request.
  assert.ok(!JSON.stringify(row).includes(ua));
});

// The Accept-Language header is sent by the visitor's browser and shown
// by get_top_languages, so only a language tag is stored.
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

// From AGENTS.md: visitor, session and time are set by the server. A
// client that sends them must not be able to choose them, or anyone
// could fake history or pretend to be another visitor.
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

// The hash must use the shortened address, as the privacy notice says.
// A unit test of truncateIp can't see whether the route passes the full
// address instead.
test("gives two addresses in one /24 the same consentless visitor_id", async () => {
  const body = {
    event: "page_view",
    url: "https://site.example/",
    props: { page_title: "Home", document_language: "en" },
  };
  const ua = "test-truncation";
  await post(body, { "user-agent": ua, "x-forwarded-for": "203.0.113.7" });
  await post(body, { "user-agent": ua, "x-forwarded-for": "203.0.113.200" });
  await post(body, { "user-agent": ua, "x-forwarded-for": "203.0.114.7" });

  const [first, sameBlock, otherBlock] = newRows();
  assert.equal(sameBlock!.visitor_id, first!.visitor_id);
  assert.notEqual(otherBlock!.visitor_id, first!.visitor_id);
});

// One installation may collect for several sites. The same person on
// two of them must be two visitors, so they aren't tracked across sites.
// example.com and www.example.com are one site, so one visitor.
test("keeps one consentless visitor and session per site, with www folded into the apex", async () => {
  const page = (url: string) => ({
    event: "page_view",
    url,
    props: { page_title: "Home", document_language: "en" },
  });
  const ua = "test-sites";
  await post(page("https://site.example/"), { "user-agent": ua });
  await post(page("https://www.site.example/a"), { "user-agent": ua });
  await post(page("https://other.example/"), { "user-agent": ua });

  const [apex, www, other] = newRows();
  assert.equal(www!.visitor_id, apex!.visitor_id);
  assert.equal(www!.session_id, apex!.session_id);
  assert.notEqual(other!.visitor_id, apex!.visitor_id);
  assert.notEqual(other!.session_id, apex!.session_id);
});

// The sender writes the url. A host the deployment didn't list would
// otherwise become a "site" the agent is offered.
test("refuses a url on a site ALLOWED_ORIGIN does not list", async () => {
  const before = rejectedCount();
  const res = await post(
    {
      event: "page_view",
      url: "https://lookalike.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": "test-unlisted-site" },
  );

  assert.equal(res.status, 400);
  assert.equal(newRows().length, 0);
  assert.equal(rejectedCount(), before + 1);
  assert.deepEqual(lastRejection(), {
    reason: "invalid_envelope",
    event: "page_view",
    detail: "url is not on a site ALLOWED_ORIGIN lists",
  });
});

// The consent cookie belongs to the collector, not the site, so it can
// follow a visitor between two sites on one collector. They stay one
// visitor (they consented), but a new site starts a new session.
test("starts a new session when a consented visitor moves to another site", async () => {
  const cookie = `genug_vid=${"b".repeat(64)}`;
  const page = (url: string) => ({
    event: "page_view",
    consent: true,
    url,
    props: { page_title: "Home", document_language: "en" },
  });
  await post(page("https://blog.site.example/"), {
    "user-agent": "test-sites-cookie",
    cookie,
  });
  await post(page("https://shop.site.example/"), {
    "user-agent": "test-sites-cookie",
    cookie,
  });

  const [blog, shop] = newRows();
  assert.equal(shop!.visitor_id, blog!.visitor_id);
  assert.notEqual(shop!.session_id, blog!.session_id);
});

// When a visitor gives consent, the cookie gets the hash they already
// had, not a new random id, so their earlier events that day stay
// theirs. With randomUUID() those events would quietly belong to
// someone else.
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

  // The id doesn't change, so the session continues instead of
  // splitting in two.
  assert.equal(rows[1]!.session_id, rows[0]!.session_id);
});

// Checks that the route applies isIssuedVisitorId to the cookie. Without
// it, anyone could create unlimited fake visitors by sending a different
// value with every request.
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

// A Cookie header with several cookies, as real sites send. A made-up
// value of 64 hex characters can't be told from a real id, so this
// shows that it is accepted.
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
  // Checks the whole Zod message, as get_top_rejected_events shows it,
  // not only that page_title is named: a vaguer or shorter message would
  // still match /page_title/.
  assert.equal(
    rejected[0]!.detail,
    "page_title: Invalid input: expected string, received number",
  );
});

test("rejects an unregistered event type", async () => {
  const ua = "test-unknown";
  const res = await post(
    // props is required even for an event without props; without it,
    // this would be rejected earlier as invalid_envelope. Mixed case, to
    // check that the stored name and the error use lowercase.
    { event: "Produt_Added_To_Cart", url: "https://site.example/", props: {} },
    { "user-agent": ua },
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "unknown event type: produt_added_to_cart",
  });
  assert.equal(newRows().length, 0);
  // An unknown name has no validation error, so there is no detail.
  assert.deepEqual(lastRejection(), {
    reason: "unknown_event_type",
    event: "produt_added_to_cart",
    detail: null,
  });

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

// All event and prop names are lowercase, so different casing is a
// typo. Names are lowercased before lookup, so the event is still
// accepted.
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

// With the same 204 as a real event, so a real visitor mistaken for a
// bot sees no error. The owner sees the count in get_bot_activity.
test("drops a bot's request with the same 204 a real event gets", async () => {
  const ua = "Googlebot/2.1 (+http://www.google.com/bot.html)";
  const botsBefore = botActivityCounter.count;
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 204);
  assert.equal(botActivityCounter.count, botsBefore + 1, "counted as a bot");
  assert.equal(newRows().length, 0);
});

// The client script marks events from a browser a program drives, which
// catches automation that fakes a real User-Agent.
test("drops an event the client marked automated, like any other bot", async () => {
  const botsBefore = botActivityCounter.count;
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
      automated: true,
    },
    { "user-agent": "test-automated" },
  );

  assert.equal(res.status, 204);
  assert.equal(
    botActivityCounter.count,
    botsBefore + 1,
    "counted as a bot, so the drop leaves a trace",
  );
  assert.equal(newRows().length, 0);
});

// Only the literal true counts. Anything else is an ordinary body, and
// the envelope drops the unknown key.
test("an automated key that isn't true leaves the event stored", async () => {
  const botsBefore = botActivityCounter.count;
  const res = await post(
    {
      event: "page_view",
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
      automated: "yes",
    },
    { "user-agent": "test-automated-not-true" },
  );

  assert.equal(res.status, 204);
  assert.equal(
    botActivityCounter.count,
    botsBefore + 0,
    "not counted as a bot",
  );
  assert.equal(newRows().length, 1);
});

// /events is public, so the client script removing these parts isn't
// enough: a request sent directly can have any query string.
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

// Cleaning the URL percent-encodes characters, so a URL under the length
// limit can become three times longer. It must still be limited.
test("rejects a url that stripping pushes over the length cap", async () => {
  const ua = "test-strip-growth";
  const url = "https://site.example/?utm_source=" + "(".repeat(2000) + "&x=1";
  assert.ok(url.length <= 2048, "the raw url must pass the envelope's cap");

  const res = await post(
    {
      event: "page_view",
      url,
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua },
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid envelope" });
  assert.equal(newRows().length, 0);
  assert.deepEqual(lastRejection(), {
    reason: "invalid_envelope",
    event: "page_view",
    detail: "url or referrer is over 2048 characters once re-encoded",
  });
});

// The event name is kept although the envelope failed, so the rejection
// shows what is broken. It wasn't length-checked, so it is cut here.
test("an invalid envelope stores the sent name, cut to the cap, or none", async () => {
  const ua = "test-invalid-envelope";
  const tooLong = await post(
    { event: "x".repeat(MAX_EVENT_NAME_LENGTH + 50), url: "nope", props: {} },
    { "user-agent": ua },
  );
  assert.equal(tooLong.status, 400);
  assert.deepEqual(await tooLong.json(), { error: "invalid envelope" });
  const cut = lastRejection();
  assert.equal(cut.reason, "invalid_envelope");
  assert.equal(cut.event, "x".repeat(MAX_EVENT_NAME_LENGTH));
  assert.ok(cut.detail, "the first failing issue is the detail");

  const notAString = await post(
    { event: 42, url: "https://site.example/", props: {} },
    { "user-agent": ua },
  );
  assert.equal(notAString.status, 400);
  const unnamed = lastRejection();
  assert.equal(unnamed.reason, "invalid_envelope");
  assert.equal(unnamed.event, null);
  assert.deepEqual(newRows(), []);
});

// Only listed origins get CORS headers, never any origin that asks:
// otherwise any website could send events here from a visitor's browser.
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

  // A second configured origin (such as www. or a staging host). The
  // header names the origin that asked, not a fixed value.
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

// Events are sent as JSON, so the browser sends a preflight first.
// Without Max-Age it is only remembered for ~5 seconds, and most events
// would need two requests.
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

// Withdrawing consent must delete the cookie, not just stop using it.
// It is httpOnly, so only this response can delete it (GDPR Art. 7(3):
// withdrawing must be as easy as consenting). This is for an explicit
// consent: false; see the next test for a missing consent field.
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

  // The row sent with the withdrawal is stored without consent. Its
  // visitor_id may still equal the cookie's, since the cookie holds that
  // day's hash (see "freezes the existing consentless hash" above).
  assert.equal(newRows()[1]!.consent_mode, "consentless");
});

// A returning visitor who already consented may send the automatic page
// view before the consent banner answers, so without a consent field but
// with their cookie. That is not "no": a missing consent field is
// different from false, and the existing cookie is used.
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

  assert.equal(
    res.headers.get("set-cookie"),
    null,
    "neither cleared nor extended: only an explicit yes may set it again",
  );

  // Confirming consent again extends the cookie, as when a consent
  // banner repeats the stored consent on every page load.
  const confirmed = await post(
    {
      event: "page_view",
      consent: true,
      url: "https://site.example/",
      props: { page_title: "Home", document_language: "en" },
    },
    { "user-agent": ua, cookie: `genug_vid=${issued}` },
  );
  const setCookie = confirmed.headers.get("set-cookie");
  assert.ok(setCookie, "an explicit yes extends the cookie");
  assert.match(setCookie, new RegExp(`genug_vid=${issued};`));
  assert.match(setCookie, /Max-Age=/, "an extension, not a clear");
  assert.doesNotMatch(setCookie, /Expires=Thu, 01 Jan 1970/i);
});

// A visitor who never consented has no cookie, so nothing is cleared
// and no Set-Cookie header is sent.
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

// The client sends a role for the three events it sends by itself, and
// the server decides the name. So a deployment can rename them without an
// old cached client.js sending a name that no longer exists.
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

// For requests not from the client script: the clicked link is cleaned
// like the page URL.
test("strips the clicked link's query and fragment on the two link roles", async () => {
  const ua = "test-role-link-urls";
  await post(
    {
      auto: "outboundClick",
      url: "https://site.example/",
      props: {
        target_url:
          "https://partner.example/x?email=a%40b.example&utm_campaign=c#t=1",
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
        file_url: "https://files.example/a.pdf?X-Amz-Signature=abc#page=2",
        file_extension: "pdf",
        link_text: "a",
      },
    },
    { "user-agent": ua },
  );

  const [outbound, download] = newRows().map(
    (row) => JSON.parse(row.props) as Record<string, string>,
  );
  assert.equal(
    outbound!.target_url,
    "https://partner.example/x?utm_campaign=c",
  );
  assert.equal(download!.file_url, "https://files.example/a.pdf");
});

// Based on the event, not on how it was sent: a track() call for the same
// event is cleaned too, so the prop's description is true for every
// row.
test("strips the link URL when the link event is sent by name too", async () => {
  await post(
    {
      event: "outbound_link_click",
      url: "https://site.example/",
      props: {
        target_url: "https://partner.example/x?token=secret",
        target_host: "partner.example",
        link_text: "x",
      },
    },
    { "user-agent": "test-link-by-name" },
  );

  const [row] = newRows();
  assert.equal(
    (JSON.parse(row!.props) as Record<string, string>).target_url,
    "https://partner.example/x",
  );
});

// Props are still checked against the event's schema; sending a role
// doesn't skip validation.
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

// All three fail the envelope check. A valid role without an event is a
// different rejection, tested in integration/wiring.test.ts.
test("rejects a role that isn't one, and a body with both or neither of role and name", async () => {
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
    assert.equal(lastRejection().reason, "invalid_envelope");
  }
  assert.deepEqual(newRows(), []);
});

// An opt-out isn't an event. It exists so the cookie can be deleted
// (it is httpOnly, so the site can't delete it), and it is never
// stored.
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

// A cookie set before a User-Agent joined the bot list must still be
// removable, so the opt-out runs before the bot check.
test("an opt-out from a User-Agent on the bot list still clears the cookie", async () => {
  const res = await post(
    { optOut: true },
    { "user-agent": "curl/8.5.0", cookie: `genug_vid=${"a".repeat(64)}` },
  );

  assert.equal(res.status, 204);
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

// The opt-out check runs before the envelope check, so adding the flag
// to an event must not let it skip validation.
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

  // The envelope ignores unknown keys, so this is stored as a normal
  // event. What matters: an event can't pass as an opt-out and clear a
  // cookie, because the opt-out schema is strict.
  assert.equal(res.status, 204);
  assert.equal(newRows().length, 1);
  assert.equal(
    res.headers.get("set-cookie"),
    null,
    "an event body must not clear the visitor cookie",
  );
});

test("the country is looked up from the shortened address only, and stays empty with the lookup off", async () => {
  const body = {
    event: "page_view",
    url: "https://site.example/",
    props: { page_title: "Home", document_language: "en" },
  };
  await post(
    body,
    { "user-agent": "test-country-1", "x-forwarded-for": "203.0.113.77" },
    "/with-country/events",
  );
  await post(
    body,
    { "user-agent": "test-country-2", "x-forwarded-for": "198.51.100.9" },
    "/with-country/events",
  );
  await post(body, {
    "user-agent": "test-country-3",
    "x-forwarded-for": "203.0.113.77",
  });

  assert.deepEqual(askedForCountry, ["203.0.113.0", "198.51.100.0"]);
  assert.deepEqual(
    newRows().map((row) => row.country),
    ["DE", "ZZ", null],
  );
});
