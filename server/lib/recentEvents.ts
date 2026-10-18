import type Database from "better-sqlite3";

// The latest stored events, newest first, for checking that tracking
// works, not for analysis. mcp/diagnostics.ts offers it together with
// rejectedEvents.ts, which lists rejected requests the same way.

export interface RecentEvent {
  event: string;
  url: string;
  ts: string;
  props: unknown;
  // The fields a spot check needs: are these two events one session, did
  // the consent mode switch, did the referrer arrive. visitor_id is left
  // out on purpose: delete_visitor_data must not trust an id taken from a
  // tool result, and never returning one keeps it that way.
  sessionId: string;
  consentMode: string;
  referrer: string | null;
  deviceType: string | null;
  browser: string | null;
}

// The most JSON one answer may contain. Each row is at most about 16KB
// (the request size limit), but 100 such rows would be ~1.6MB, far more
// than an agent can read. 64K characters fits 100 normal rows (~500
// characters each) or at least four of the largest possible ones.
export const MAX_RECENT_EVENTS_CHARS = 64_000;

export interface RecentEvents {
  rows: RecentEvent[];
  // True when rows were left out to stay under the size limit, so fewer
  // came back than `limit` asked for although more exist.
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

  // Always keep the newest row, even if it alone is too big: an empty
  // list would read as "no traffic".
  let chars = 0;
  for (let i = 0; i < events.length; i++) {
    chars += JSON.stringify(events[i]).length + 1;
    if (i > 0 && chars > maxChars) {
      return { rows: events.slice(0, i), truncated: true };
    }
  }
  return { rows: events, truncated: false };
}
