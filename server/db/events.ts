import type Database from "better-sqlite3";

export type ConsentMode = "consentful" | "consentless";

export interface EventRow {
  event: string;
  visitorId: string;
  sessionId: string;
  ts: string;
  url: string;
  referrer?: string;
  // The User-Agent header's classification (lib/userAgent.ts), never the
  // header. Both undefined only when the request carried no header at
  // all; an unrecognised one still classifies, to "Other"/"other".
  deviceType?: string;
  browser?: string;
  visitorLanguage?: string;
  props: unknown;
  idempotencyKey?: string;
  // Optional here, but never NULL in the database — this default is
  // what keeps the column that way. routes/events.ts always passes an
  // explicit value, computed from whether a persistent id was actually
  // used for this row, which is a narrower question than what the
  // envelope's own (now three-valued) `consent` field said on this
  // particular request — see "Visitor identification" in
  // docs/decisions.md.
  consentMode?: ConsentMode;
}

// Returns false when a row with the same (event, idempotencyKey) pair
// was already inserted — idx_events_dedup's ON CONFLICT silently drops
// the duplicate rather than inserting a second row. Events that never
// set idempotencyKey (the common case) always insert and always return
// true — see migrations.ts for why NULLs never collide with each other.
export function insertEvent(db: Database.Database, row: EventRow): boolean {
  const result = db
    .prepare(
      `INSERT INTO events (event, visitor_id, session_id, ts, url, referrer, device_type, browser, visitor_language, props, idempotency_key, consent_mode)
       VALUES (@event, @visitorId, @sessionId, @ts, @url, @referrer, @deviceType, @browser, @visitorLanguage, @props, @idempotencyKey, @consentMode)
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
      props: JSON.stringify(row.props),
      idempotencyKey: row.idempotencyKey ?? null,
      consentMode: row.consentMode ?? "consentless",
    });
  return result.changes > 0;
}

export interface LastEvent {
  sessionId: string;
  ts: string;
}

export function findLastEventForVisitor(
  db: Database.Database,
  visitorId: string,
): LastEvent | undefined {
  const row = db
    .prepare(
      `SELECT session_id, ts FROM events WHERE visitor_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(visitorId) as { session_id: string; ts: string } | undefined;

  if (!row) return undefined;
  return { sessionId: row.session_id, ts: row.ts };
}
