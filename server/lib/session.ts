import { randomUUID } from "node:crypto";
import type { LastEvent } from "../db/events.js";
import { siteHost } from "./url.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Returns the visitor's current session id, or a new one when there is
// no earlier event, the last one is over 30 minutes old, or it was on
// another site. A new visitor_id has no earlier event, so it always
// starts a new session.
//
// Why a change of site matters: the consent cookie belongs to the
// collector's hostname, so two sites sharing one collector hostname
// (docs/deploying.md says not to) share the cookie. Without this check
// one session could span both sites.
export function resolveSessionId(
  lastEvent: LastEvent | undefined,
  now: Date,
  site: string,
): string {
  if (!lastEvent) {
    return randomUUID();
  }

  const elapsed = now.getTime() - new Date(lastEvent.ts).getTime();
  if (elapsed > SESSION_TIMEOUT_MS) {
    return randomUUID();
  }

  if (siteHost(lastEvent.url) !== site) {
    return randomUUID();
  }

  return lastEvent.sessionId;
}
