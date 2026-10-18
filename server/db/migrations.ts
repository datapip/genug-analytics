import type Database from "better-sqlite3";

// Runs the migrations this database file hasn't had yet. The count of
// those already run is kept in SQLite's PRAGMA user_version, a number in
// the file's header, so no extra table is needed. Each migration and its
// version update run in one transaction, so a crash can't leave a step
// half done or run it twice.
//
// `migrations` is a parameter so tests can pass a small list of their
// own.
export function runMigrations(
  db: Database.Database,
  migrations: ((db: Database.Database) => void)[],
): void {
  const current = db.pragma("user_version", { simple: true }) as number;

  // A database with more steps than this build knows was written by a
  // newer version of Genug. Without this check the old code would run
  // against tables it doesn't know, without any warning. Going back to
  // an older image is common, so stop with an error.
  if (current > migrations.length) {
    throw new Error(
      `This database is at schema version ${current}, but this build only ` +
        `knows ${migrations.length}. It was created by a newer version of ` +
        `genug: run that version again, or restore a backup taken before ` +
        `the upgrade.`,
    );
  }

  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      migrations[v]!(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// The schema changes in order: the first schema, then each change.
//
// ONLY ADD AT THE END. A database remembers how many steps it has run,
// so changing or removing an entry doesn't affect databases that
// already ran it; it only makes this list wrong about them.
export const migrations: ((db: Database.Database) => void)[] = [
  // Migration 0: the whole schema.
  //
  // auto_vacuum must be set before any table exists, or it needs a full
  // VACUUM. INCREMENTAL lets the space of deleted rows be given back a
  // little at a time (lib/retention.ts and the daily incremental_vacuum
  // in server/index.ts), without the long blocking rewrite of a full
  // VACUUM.
  (db) => {
    db.pragma("auto_vacuum = INCREMENTAL");
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        url TEXT NOT NULL,
        referrer TEXT,
        -- What the User-Agent header classified to (lib/userAgent.ts),
        -- not the header itself. The raw string is read for bot
        -- detection and the consentless hash and then dropped: the
        -- only question ever asked of it is "which browser on which
        -- device", so that is all that is kept (Art. 5(1)(c)).
        device_type TEXT,
        browser TEXT,
        visitor_language TEXT,
        props TEXT NOT NULL,
        -- Optional, and supplied by the deployment rather than the
        -- client script (typically a real order id): it identifies the
        -- real-world occurrence, so a refreshed or back-navigated
        -- confirmation page can't double-count a revenue event toward
        -- get_property_sum. Most events never set one.
        idempotency_key TEXT,
        -- NOT NULL because every row genuinely has a consent mode:
        -- the envelope's own consent field defaults to false, so an
        -- event that says nothing about consent is consentless by this
        -- project's definition, not unknown. See db/events.ts.
        consent_mode TEXT NOT NULL
      );

      CREATE INDEX idx_events_visitor_ts
        ON events (visitor_id, ts DESC);

      CREATE INDEX idx_events_ts
        ON events (ts);

      -- Per-session aggregates (average session duration, entry/exit/
      -- bounce pages) all GROUP BY session_id.
      CREATE INDEX idx_events_session_ts
        ON events (session_id, ts);

      -- Partial — only rows that actually set a key are constrained.
      -- SQLite treats every NULL as distinct in a unique index, so
      -- events without a key (the common case) are never compared
      -- against each other and always insert.
      CREATE UNIQUE INDEX idx_events_dedup
        ON events (event, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      -- A lot of queries filter on an event type *and* a time range
      -- together: every page-view-scoped metric (get_top_pages,
      -- get_top_referrers, entry/exit/bounce pages, the viewEvents half
      -- of every traffic summary), plus get_events_by_property and
      -- get_property_sum. Ordered (event, ts) rather than (ts, event)
      -- because equality-then-range is the order SQLite can actually
      -- seek on: it narrows to one event type first, then walks only
      -- that type's slice of the period.
      CREATE INDEX idx_events_event_ts
        ON events (event, ts);

      -- A request routes/events.ts rejects (a malformed envelope, an
      -- unregistered event type, or props that don't match that event's
      -- schema) never reaches the events table, so a broken integration
      -- would otherwise be invisible. A separate table rather than a
      -- differently-tagged row in events, since a rejected request never
      -- got a trustworthy visitor/session identity.
      --
      -- The event column is nullable: a sufficiently malformed request may
      -- not even have a readable event name. detail is too: it summarises
      -- the failing Zod issue, and unknown_event_type has no validation
      -- error to summarise (the event name is already the useful part).
      CREATE TABLE rejected_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        reason TEXT NOT NULL,
        event TEXT,
        detail TEXT
      );

      CREATE INDEX idx_rejected_events_ts
        ON rejected_events (ts);

      -- Hourly snapshots of how many requests lib/bots.ts silently
      -- dropped, so that best-effort filtering has some visibility.
      -- Deliberately not a row per bot hit: bot traffic can spike far
      -- more unpredictably than real events, so writing one per request
      -- would scale with exactly the wrong thing. An in-memory counter
      -- (lib/botActivity.ts) accumulates hits and a background job
      -- flushes it here once an hour, and only for an hour that
      -- actually saw any.
      CREATE TABLE bot_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        count INTEGER NOT NULL
      );

      CREATE INDEX idx_bot_activity_ts
        ON bot_activity (ts);
    `);
  },

  // Migration 1: the visitor's country (lib/country.ts). A two-letter
  // code, "ZZ" when the lookup found nothing, and NULL when no lookup ran
  // (rows stored before this column existed, or with COUNTRY_LOOKUP off),
  // so "not looked up" never reads as "unknown country".
  (db) => {
    db.exec(`ALTER TABLE events ADD COLUMN country TEXT`);
  },
];

export function migrate(db: Database.Database): void {
  runMigrations(db, migrations);
}
