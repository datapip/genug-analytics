import { randomUUID } from "node:crypto";
import type { LastEvent } from "../db/events.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// A brand-new visitor_id has no prior row, so "new session whenever
// visitor_id changes" falls out of this for free — no separate check.
export function resolveSessionId(
  lastEvent: LastEvent | undefined,
  now: Date,
): string {
  if (!lastEvent) {
    return randomUUID();
  }

  const elapsed = now.getTime() - new Date(lastEvent.ts).getTime();
  if (elapsed > SESSION_TIMEOUT_MS) {
    return randomUUID();
  }

  return lastEvent.sessionId;
}
