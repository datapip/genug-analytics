import { randomUUID } from "node:crypto";
import type { LastEvent } from "../db/events.js";
import { siteHost } from "./url.js";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// A brand-new visitor_id has no prior row, so "new session whenever
// visitor_id changes" falls out of this for free — no separate check.
//
// A change of site ends the session too. The consentless hash already
// keeps sites apart, but a consent cookie belongs to the collector
// hostname: two sites sharing one — which docs/deploying.md says not to
// do — share the cookie. A session spanning both would sit under one
// site in the host segment and leave the other with an entry page but
// no exit.
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
