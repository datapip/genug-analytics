import type Database from "better-sqlite3";

// The three points routes/events.ts can reject a request at, before it
// ever becomes a real row in events — a request failing for any of
// these reasons never got a trustworthy visitor/session identity, so it
// can't just be a differently-tagged row in that table.
export type RejectionReason =
  "invalid_envelope" | "unknown_event_type" | "invalid_props";

// `ts` is an explicit parameter, not computed in here, same as
// insertEvent — the caller stamps "now" once and reuses it, rather than
// this function silently taking its own reading of the clock (which
// would also make it untestable with a fixed period).
// `event` is best-effort and often absent: a request rejected as
// invalid_envelope may not even have a readable event name. `detail` is
// likewise best-effort — a short summary of *why* (e.g. the first
// failing Zod issue), absent for unknown_event_type since there's no
// validation error to summarize there.
export function insertRejectedEvent(
  db: Database.Database,
  reason: RejectionReason,
  ts: string,
  event?: string,
  detail?: string,
): void {
  db.prepare(
    `INSERT INTO rejected_events (ts, reason, event, detail)
     VALUES (@ts, @reason, @event, @detail)`,
  ).run({
    ts,
    reason,
    event: event ?? null,
    detail: detail ?? null,
  });
}
