import type Database from "better-sqlite3";

// Raw event rows, newest first — for spot-checking that tracking works
// at all, not for analysis. Sibling of rejectedEvents.ts: both list raw
// rows rather than aggregating them, and mcp/diagnostics.ts exposes the
// pair together.

export interface RecentEvent {
  event: string;
  url: string;
  ts: string;
  props: unknown;
  // The envelope fields a spot check is actually about: "are these two
  // hits one session", "did the consent banner switch modes", "did the
  // referrer survive". All of it already reaches the agent through the
  // aggregates — except visitor_id, which stays out: delete_visitor_data
  // treats an id read from a tool result as untrusted, and not returning
  // one is the simplest way to keep that true.
  sessionId: string;
  consentMode: string;
  referrer: string | null;
  deviceType: string | null;
  browser: string | null;
}

// How much serialized JSON one answer may carry. A row's size is
// already bounded — every string prop is capped, and a whole event by
// the 16KB request body — but 100 rows at that bound is ~1.6MB, far past
// any model's context. 64K characters still fits 100 ordinary rows
// (~500 characters each) and at least four of the largest possible ones.
export const MAX_RECENT_EVENTS_CHARS = 64_000;

export interface RecentEvents {
  rows: RecentEvent[];
  // True when rows were dropped to stay inside the budget, so fewer came
  // back than `limit` asked for even though more exist.
  truncated: boolean;
}

export function getRecentEvents(
  db: Database.Database,
  limit: number,
  maxChars = MAX_RECENT_EVENTS_CHARS,
): RecentEvents {
  const rows = db
    .prepare(
      `SELECT event, url, ts, props, session_id, consent_mode, referrer,
              device_type, browser
       FROM events
       ORDER BY ts DESC
       LIMIT @limit`,
    )
    .all({ limit }) as {
    event: string;
    url: string;
    ts: string;
    props: string;
    session_id: string;
    consent_mode: string;
    referrer: string | null;
    device_type: string | null;
    browser: string | null;
  }[];

  const events = rows.map((row) => ({
    event: row.event,
    url: row.url,
    ts: row.ts,
    props: JSON.parse(row.props) as unknown,
    sessionId: row.session_id,
    consentMode: row.consent_mode,
    referrer: row.referrer,
    deviceType: row.device_type,
    browser: row.browser,
  }));

  // Always keep the newest row, so a single oversized one still comes
  // back rather than an empty list that reads as "no traffic".
  let chars = 0;
  for (let i = 0; i < events.length; i++) {
    chars += JSON.stringify(events[i]).length + 1;
    if (i > 0 && chars > maxChars) {
      return { rows: events.slice(0, i), truncated: true };
    }
  }
  return { rows: events, truncated: false };
}
