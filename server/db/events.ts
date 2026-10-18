import type Database from "better-sqlite3";

export type ConsentMode = "consentful" | "consentless";

export interface EventRow {
  event: string;
  visitorId: string;
  sessionId: string;
  ts: string;
  url: string;
  referrer?: string;
  // The category lib/userAgent.ts derives from the User-Agent header; the
  // header itself is never stored. Undefined only when the request had no
  // User-Agent; an unknown one becomes "Other"/"other".
  deviceType?: string;
  browser?: string;
  visitorLanguage?: string;
  // Undefined (stored as NULL) when the country lookup is off.
  country?: string;
  props: unknown;
  idempotencyKey?: string;
  // Optional here, but the default keeps the column from ever being NULL.
  // routes/events.ts always passes a value: whether this row was
  // identified by the consent cookie. That can differ from what the
  // request's `consent` field said (see "Visitor identification" in
  // docs/decisions.md).
  consentMode?: ConsentMode;
}

// Returns false when a row with the same event and idempotencyKey already
// exists: the unique index idx_events_dedup makes SQLite skip the
// duplicate. Events without an idempotencyKey (most of them) are always
// inserted, because SQLite never treats two NULLs as equal.
export function insertEvent(db: Database.Database, row: EventRow): boolean {
  const result = db
    .prepare(
      `INSERT INTO events (event, visitor_id, session_id, ts, url, referrer, device_type, browser, visitor_language, country, props, idempotency_key, consent_mode)
       VALUES (@event, @visitorId, @sessionId, @ts, @url, @referrer, @deviceType, @browser, @visitorLanguage, @country, @props, @idempotencyKey, @consentMode)
       ON CONFLICT (event, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    )
    .run({
      event: row.event,
      visitorId: row.visitorId,
      sessionId: row.sessionId,
      ts: row.ts,
      url: row.url,
      referrer: row.referrer ?? null,
      deviceType: row.deviceType ?? null,
      browser: row.browser ?? null,
      visitorLanguage: row.visitorLanguage ?? null,
      country: row.country ?? null,
      props: JSON.stringify(row.props),
      idempotencyKey: row.idempotencyKey ?? null,
      consentMode: row.consentMode ?? "consentless",
    });
  return result.changes > 0;
}

export interface LastEvent {
  sessionId: string;
  ts: string;
  url: string;
}

export function findLastEventForVisitor(
  db: Database.Database,
  visitorId: string,
): LastEvent | undefined {
  const row = db
    .prepare(
      `SELECT session_id, ts, url FROM events WHERE visitor_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(visitorId) as
    { session_id: string; ts: string; url: string } | undefined;

  if (!row) return undefined;
  return { sessionId: row.session_id, ts: row.ts, url: row.url };
}
