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

export function getRecentEvents(
  db: Database.Database,
  limit: number,
): RecentEvent[] {
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

  return rows.map((row) => ({
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
}
