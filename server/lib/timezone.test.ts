import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import {
  enumerateDays,
  localSpans,
  localDate,
  localDayStart,
  offsetMinutes,
  offsetSpans,
} from "./timezone.js";

test("offsetMinutes follows the clock change", () => {
  assert.equal(
    offsetMinutes(Date.parse("2026-07-01T12:00:00Z"), "Europe/Berlin"),
    120,
  );
  assert.equal(
    offsetMinutes(Date.parse("2026-12-01T12:00:00Z"), "Europe/Berlin"),
    60,
  );
  assert.equal(
    offsetMinutes(Date.parse("2026-12-01T12:00:00.999Z"), "America/New_York"),
    -300,
  );
  assert.equal(offsetMinutes(Date.parse("2026-12-01T12:00:00Z"), "UTC"), 0);
});

// 00:30 in Berlin in summer is 22:30 the day before in UTC.
test("localDate is the site's day, not UTC's", () => {
  assert.equal(
    localDate(Date.parse("2026-09-30T22:30:00Z"), "Europe/Berlin"),
    "2026-10-01",
  );
  assert.equal(
    localDate(Date.parse("2026-09-30T22:30:00Z"), "UTC"),
    "2026-09-30",
  );
});

test("localDayStart finds local midnight on either side of a clock change", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  assert.equal(
    iso(localDayStart("2026-10-25", "Europe/Berlin")),
    "2026-10-24T22:00:00.000Z",
  );
  assert.equal(
    iso(localDayStart("2026-10-26", "Europe/Berlin")),
    "2026-10-25T23:00:00.000Z",
  );
});

// Chile moves its clocks at midnight, so 6 September 2026 has no 00:00:
// the day starts at the change, 01:00 local.
test("localDayStart is the change itself where midnight does not exist", () => {
  assert.equal(
    new Date(localDayStart("2026-09-06", "America/Santiago")).toISOString(),
    "2026-09-06T04:00:00.000Z",
  );
});

test("offsetSpans is one open span when no clock changes inside the period", () => {
  assert.deepEqual(
    offsetSpans(
      "2026-09-01T00:00:00.000Z",
      "2026-09-30T00:00:00.000Z",
      "Europe/Berlin",
    ),
    [{ start: "", end: "9999", offset: 120 }],
  );
});

// The spans touch without overlap: each ends where the next starts, in
// the format `ts` is stored in.
test("offsetSpans splits at the clock change, contiguous and in the stored format", () => {
  assert.deepEqual(
    offsetSpans(
      "2026-03-01T00:00:00.000Z",
      "2026-11-30T00:00:00.000Z",
      "Europe/Berlin",
    ),
    [
      { start: "", end: "2026-03-29T01:00:00.000Z", offset: 60 },
      {
        start: "2026-03-29T01:00:00.000Z",
        end: "2026-10-25T01:00:00.000Z",
        offset: 120,
      },
      { start: "2026-10-25T01:00:00.000Z", end: "9999", offset: 60 },
    ],
  );
});

// An agent can ask from year 1. The search follows the stored rows, so a
// huge period costs nothing.
test("localSpans scans only between the stored rows, not the bounds asked for", () => {
  const db = new Database(":memory:");
  migrate(db);
  insertEvent(db, {
    event: "page_view",
    visitorId: "v",
    sessionId: "s",
    ts: "2026-07-01T12:00:00.000Z",
    url: "https://example.com/",
    props: {},
  });
  const started = performance.now();
  const spans = localSpans(
    db,
    { from: "0001-01-01T00:00:00.000Z", to: "9999-12-31T23:59:59.999Z" },
    "Europe/Berlin",
  );
  assert.ok(performance.now() - started < 200);
  assert.deepEqual(JSON.parse(spans), [
    { start: "", end: "9999", offset: 120 },
  ]);
});

test("enumerateDays lists local days, including a 25-hour one", () => {
  assert.deepEqual(
    enumerateDays(
      "2026-10-24T22:00:00.000Z",
      "2026-10-26T22:59:59.999Z",
      "Europe/Berlin",
    ),
    ["2026-10-25", "2026-10-26"],
  );
});

// No query may group by day or hour with a plain strftime on `ts`,
// which would use UTC. Checks the compiled files next to this test,
// which contain the same SQL as the sources.
test("no query in lib/ buckets on ts without the site's offset", () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const offenders = readdirSync(dir)
    .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
    .flatMap((file) =>
      (readFileSync(join(dir, file), "utf8").match(/strftime\([^)]*\)/g) ?? [])
        .filter((call) => /\bts\b/.test(call) && !call.includes("span_offset"))
        .map((call) => `${file}: ${call}`),
    );
  assert.deepEqual(offenders, []);
});
