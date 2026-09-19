import type Database from "better-sqlite3";

// 14 months — the figure docs/operations.md and docs/privacy.md already
// point deployers toward as what to configure, now also what applies
// when nobody does. See "Data lifecycle" in docs/decisions.md for why
// unset stopped meaning forever.
export const DEFAULT_RETENTION_DAYS = 425;

// Fails fast on a bad value rather than silently ignoring it or running
// with a nonsensical window — same reasoning as requireEnv's guard.
//
// Three states, not two, now that unset defaults to a real number
// rather than to unlimited: unset means DEFAULT_RETENTION_DAYS, `-1`
// means unlimited on purpose — the explicit way to say what unset used
// to mean by default, which a deployer who actually wants that needs to
// be able to state now that omitting it no longer says it for them —
// and any other positive number means that many days.
//
// `0` is deliberately not the sentinel, and is rejected with its own
// message rather than falling into the generic one: "0 days" reads as
// "keep nothing", the opposite of unlimited, and someone would only
// find out they'd misread it once their data was already gone. `-1`
// has no plausible reading as a day count at all, so nobody can
// confidently guess wrong — they have to look it up, which is the
// safer failure mode for a setting this destructive to get backwards.
export function parseRetentionDays(
  value: string | undefined,
): number | undefined {
  if (value === undefined) return DEFAULT_RETENTION_DAYS;
  const days = Number(value);
  if (days === -1) return undefined;
  if (days === 0) {
    throw new Error(
      `RETENTION_DAYS=0 is not accepted — it reads as "keep nothing", ` +
        `not "keep forever". Use -1 for no limit.`,
    );
  }
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(
      `RETENTION_DAYS must be a positive number of days, or -1 for no limit, got: ${value}`,
    );
  }
  return days;
}

// The one piece the three prune functions below genuinely shared. Worth
// extracting because it's the part that could silently diverge: three
// copies of the same date arithmetic is three chances for one of them to
// end up computing a different cutoff than the others.
//
// The SQL statements themselves stay written out per table rather than
// collapsing into one `DELETE FROM ${table}` helper, matching the call
// already made for getEntryPages/getExitPages (see "MCP tool design" in
// docs/decisions.md): a one-line literal query per table is clearer than
// building SQL text from an interpolated identifier, even one that can
// only ever be an internal hardcoded value. It also keeps the call
// sites naming what they prune rather than passing a table string.
function retentionCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function pruneOldEvents(db: Database.Database, days: number): number {
  return db
    .prepare(`DELETE FROM events WHERE ts < ?`)
    .run(retentionCutoff(days)).changes;
}

// Pruned by the same RETENTION_DAYS setting and job as events — one
// retention knob to explain, not two, and rejected_events is diagnostic
// data with no reason to outlive the real events it was rejected instead
// of becoming.
export function pruneOldRejectedEvents(
  db: Database.Database,
  days: number,
): number {
  return db
    .prepare(`DELETE FROM rejected_events WHERE ts < ?`)
    .run(retentionCutoff(days)).changes;
}

// Same reasoning as pruneOldRejectedEvents: rides along on
// RETENTION_DAYS rather than a third retention setting. bot_activity
// is already low-volume by construction (at most one row per hour), so
// this mostly matters on a very long-lived deployment.
export function pruneOldBotActivity(
  db: Database.Database,
  days: number,
): number {
  return db
    .prepare(`DELETE FROM bot_activity WHERE ts < ?`)
    .run(retentionCutoff(days)).changes;
}

export function countEventsForVisitor(
  db: Database.Database,
  visitorId: string,
): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE visitor_id = ?`)
    .get(visitorId) as { count: number };
  return row.count;
}

export function deleteVisitorData(
  db: Database.Database,
  visitorId: string,
): number {
  const result = db
    .prepare(`DELETE FROM events WHERE visitor_id = ?`)
    .run(visitorId);
  return result.changes;
}
