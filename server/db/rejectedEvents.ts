import type Database from "better-sqlite3";

// Why routes/events.ts rejected a request. Rejected requests are kept in
// their own table, not in `events`, because they never got a visitor or
// session id.
export type RejectionReason =
  "invalid_envelope" | "unknown_event_type" | "invalid_props";

// The caller passes `ts` instead of this function reading the clock, so a
// test can store rows at a fixed time.
// `event` is often missing: an invalid request may have no readable event
// name. `detail` is a short reason (such as the first failing Zod check)
// and is missing for unknown_event_type, which has no validation error.
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
