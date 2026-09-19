import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { runMigrations, migrate } from "./migrations.js";

test("migrate creates a queryable events table on a fresh database", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    `INSERT INTO events (event, visitor_id, session_id, ts, url, props, consent_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "page_view",
    "visitor-1",
    "session-1",
    "2026-01-01T00:00:00.000Z",
    "https://example.com",
    "{}",
    "consentless",
  );

  const row = db
    .prepare("SELECT * FROM events WHERE visitor_id = ?")
    .get("visitor-1");
  assert.ok(row);
});

test("migrate enables incremental auto_vacuum, so deleted space can be reclaimed later", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.equal(db.pragma("auto_vacuum", { simple: true }), 2); // 2 = INCREMENTAL
});

test("migrate creates an index on session_id for per-session aggregates", () => {
  const db = new Database(":memory:");
  migrate(db);
  const indexes = db.pragma("index_list(events)") as { name: string }[];
  assert.ok(indexes.some((i) => i.name === "idx_events_session_ts"));
});

test("migrate creates an idempotency_key column and a partial unique index on it", () => {
  const db = new Database(":memory:");
  migrate(db);

  const columns = db.pragma("table_info(events)") as { name: string }[];
  assert.ok(columns.some((c) => c.name === "idempotency_key"));

  const indexes = db.pragma("index_list(events)") as {
    name: string;
    unique: number;
  }[];
  const dedupIndex = indexes.find((i) => i.name === "idx_events_dedup");
  assert.ok(dedupIndex);
  assert.equal(dedupIndex.unique, 1);
});

test("migrate creates a queryable rejected_events table", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    `INSERT INTO rejected_events (ts, reason, event) VALUES (?, ?, ?)`,
  ).run("2026-01-01T00:00:00.000Z", "invalid_props", "order_completed");

  const row = db
    .prepare("SELECT * FROM rejected_events WHERE reason = ?")
    .get("invalid_props");
  assert.ok(row);

  const indexes = db.pragma("index_list(rejected_events)") as {
    name: string;
  }[];
  assert.ok(indexes.some((i) => i.name === "idx_rejected_events_ts"));
});

test("migrate creates a queryable bot_activity table", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(`INSERT INTO bot_activity (ts, count) VALUES (?, ?)`).run(
    "2026-01-01T00:00:00.000Z",
    5,
  );

  const row = db.prepare("SELECT * FROM bot_activity WHERE count = ?").get(5);
  assert.ok(row);

  const indexes = db.pragma("index_list(bot_activity)") as {
    name: string;
  }[];
  assert.ok(indexes.some((i) => i.name === "idx_bot_activity_ts"));
});

test("migrate creates a nullable detail column on rejected_events", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    `INSERT INTO rejected_events (ts, reason, event, detail) VALUES (?, ?, ?, ?)`,
  ).run(
    "2026-01-01T00:00:00.000Z",
    "invalid_props",
    "order_completed",
    "value: Expected number, received string",
  );

  const row = db
    .prepare("SELECT detail FROM rejected_events WHERE reason = ?")
    .get("invalid_props") as { detail: string };
  assert.equal(row.detail, "value: Expected number, received string");

  const columns = db.pragma("table_info(rejected_events)") as {
    name: string;
  }[];
  assert.ok(columns.some((c) => c.name === "detail"));
});

test("migrate creates a NOT NULL consent_mode column on events", () => {
  const db = new Database(":memory:");
  migrate(db);

  db.prepare(
    `INSERT INTO events (event, visitor_id, session_id, ts, url, props, consent_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "page_view",
    "visitor-1",
    "session-1",
    "2026-01-01T00:00:00.000Z",
    "https://example.com",
    "{}",
    "consentful",
  );

  const row = db
    .prepare("SELECT consent_mode FROM events WHERE visitor_id = ?")
    .get("visitor-1") as { consent_mode: string };
  assert.equal(row.consent_mode, "consentful");

  const columns = db.pragma("table_info(events)") as {
    name: string;
    notnull: number;
  }[];
  const consentMode = columns.find((c) => c.name === "consent_mode");
  assert.ok(consentMode);
  // Every row has a consent mode — an event that says nothing about
  // consent is consentless, not unknown. Enforcing it here is what lets
  // getConsentBreakdown report exactly two buckets.
  assert.equal(consentMode.notnull, 1, "consent_mode should be NOT NULL");
});

test("migrate is safe to call twice — the second call is a no-op", () => {
  const db = new Database(":memory:");
  migrate(db);
  assert.doesNotThrow(() => migrate(db));
  assert.equal(db.pragma("user_version", { simple: true }), 1);
});

// Every event-type-plus-period query depends on this composite index,
// and an index is the kind of thing that can be
// dropped by accident while the queries still return correct results —
// just slowly. Pinning it means that regression fails a test rather
// than quietly becoming a performance problem later.
test("migrate creates the (event, ts) composite index", () => {
  const db = new Database(":memory:");
  migrate(db);

  const indexes = db.pragma("index_list(events)") as { name: string }[];
  assert.ok(
    indexes.some((i) => i.name === "idx_events_event_ts"),
    "idx_events_event_ts should exist",
  );

  const columns = db.pragma("index_info(idx_events_event_ts)") as {
    name: string;
  }[];
  assert.deepEqual(
    columns.map((c) => c.name),
    ["event", "ts"],
    "equality column first, range column second, so SQLite can seek",
  );
});

test("runMigrations only runs migrations after the database's current version", () => {
  const db = new Database(":memory:");
  const ran: number[] = [];
  const fakeMigrations = [
    (db: Database.Database) => {
      ran.push(0);
      db.exec("CREATE TABLE a (id INTEGER)");
    },
    (db: Database.Database) => {
      ran.push(1);
      db.exec("CREATE TABLE b (id INTEGER)");
    },
  ];

  // Pretend this database already went through migration 0 — e.g. an
  // existing production database seeing migration 1 for the first time.
  db.pragma("user_version = 1");

  runMigrations(db, fakeMigrations);

  assert.deepEqual(ran, [1]);
  assert.equal(db.pragma("user_version", { simple: true }), 2);
  assert.throws(() => db.prepare("SELECT * FROM a").get()); // never (re)created
  assert.doesNotThrow(() => db.prepare("SELECT * FROM b").get());
});

test("runMigrations runs every migration in order on a brand-new database", () => {
  const db = new Database(":memory:");
  const ran: number[] = [];
  const fakeMigrations = [
    (db: Database.Database) => {
      ran.push(0);
      db.exec("CREATE TABLE a (id INTEGER)");
    },
    (db: Database.Database) => {
      ran.push(1);
      db.exec("CREATE TABLE b (id INTEGER)");
    },
  ];

  runMigrations(db, fakeMigrations);

  assert.deepEqual(ran, [0, 1]);
  assert.equal(db.pragma("user_version", { simple: true }), 2);
});

// Pinning an older image tag is an ordinary user action once tags are
// published, and the version number is the only thing that can notice.
test("runMigrations refuses a database written by a newer build", () => {
  const db = new Database(":memory:");
  const ran: number[] = [];
  const fakeMigrations = [
    (db: Database.Database) => {
      ran.push(0);
      db.exec("CREATE TABLE a (id INTEGER)");
    },
  ];

  db.pragma("user_version = 3");

  assert.throws(
    () => runMigrations(db, fakeMigrations),
    /schema version 3, but this build only knows 1/,
  );
  assert.deepEqual(ran, [], "nothing should be applied");
  assert.equal(db.pragma("user_version", { simple: true }), 3);
});
