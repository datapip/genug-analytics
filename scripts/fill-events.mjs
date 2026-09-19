// Fills an events table with synthetic rows, so query time can be
// measured against a database the size a deployment will actually reach.
// Ingest throughput is scripts/load-events.mjs's job — this one only
// cares how big the table is when a question is asked of it.
//
//   node scripts/fill-events.mjs ./genug.db 1000000
//
// Point it at a database the server has already created (it needs the
// schema, and writes nothing else), with the server stopped. Keep the
// result as a pristine copy and restore it before each measurement:
// load-events.mjs writes rows timestamped now, so one run leaves every
// later window measurement reading its leftovers rather than this fill. The rows
// are plausible rather than real: page views, outbound clicks and
// orders spread over a year, with a handful of pages, referrers,
// devices and languages.
//
// Fills the events table to a realistic size so query latency can be
// measured against one. Ingest throughput is measured over HTTP by
// load.mjs — this is only about how big the table is when a question is
// asked of it, so it writes rows directly, in one transaction.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const path = process.argv[2];
const target = Number(process.argv[3] ?? 1_000_000);
if (!path) {
  console.error("usage: node scripts/fill-events.mjs <db-path> [rows]");
  process.exit(1);
}
const DAYS = 365;

const db = new Database(path);
const already = db.prepare("SELECT COUNT(*) c FROM events").get().c;
const toWrite = Math.max(0, target - already);

const PAGES = [
  "/",
  "/pricing",
  "/blog/how-we-built-it",
  "/docs",
  "/contact",
  "/features",
  "/about",
];
const REFERRERS = [
  null,
  "https://news.ycombinator.com/",
  "https://www.google.com/",
  "https://x.com/",
  null,
  null,
];
const DEVICES = ["desktop", "mobile", "tablet"];
const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge"];
const LANGS = ["en", "de", "fr", "en"];
// A tenth of the traffic is a conversion-shaped event with props worth
// summing, because several queries only touch those rows.
const EVENTS = [
  "page_view",
  "page_view",
  "page_view",
  "page_view",
  "page_view",
  "page_view",
  "page_view",
  "page_view",
  "outbound_link_click",
  "order_completed",
];

const insert = db.prepare(`
  INSERT INTO events (event, visitor_id, session_id, ts, url, referrer,
                      device_type, browser, visitor_language, props,
                      idempotency_key, consent_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const now = Date.now();
const started = Date.now();
const write = db.transaction((from, count) => {
  for (let i = from; i < from + count; i++) {
    const visitor = `v${i % 400_000}`;
    const session = `s${Math.floor(i / 6)}`;
    // Spread over a year, newest last.
    const ts = new Date(
      now - Math.floor((1 - i / target) * DAYS * 86_400_000),
    ).toISOString();
    const event = EVENTS[i % EVENTS.length];
    const props =
      event === "order_completed"
        ? JSON.stringify({
            order_id: `o${i}`,
            total: (i % 400) + 9.99,
            currency: "EUR",
          })
        : event === "outbound_link_click"
          ? JSON.stringify({
              target_url: "https://partner.example.com/x",
              target_host: "partner.example.com",
              link_text: "See our partner",
            })
          : JSON.stringify({
              page_title: "Example page",
              document_language: LANGS[i % LANGS.length],
            });

    insert.run(
      event,
      visitor,
      session,
      ts,
      `https://example.com${PAGES[i % PAGES.length]}`,
      REFERRERS[i % REFERRERS.length],
      DEVICES[i % DEVICES.length],
      BROWSERS[i % BROWSERS.length],
      LANGS[i % LANGS.length],
      props,
      event === "order_completed" ? `o${i}` : null,
      i % 4 === 0 ? "consentful" : "consentless",
    );
  }
});

const BATCH = 50_000;
for (let done = 0; done < toWrite; done += BATCH) {
  write(already + done, Math.min(BATCH, toWrite - done));
  process.stdout.write(
    `\r${already + done + Math.min(BATCH, toWrite - done)} rows`,
  );
}
console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
db.close();
