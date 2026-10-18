import type { Request, Response, Router } from "express";
import { z } from "zod";
import {
  eventRegistry,
  reloadEvents,
  resetEvents,
} from "@genug/schema-registry";
import { getStoredEventCounts } from "../../lib/events.js";
import { resetDatabase } from "../../lib/resetDatabase.js";
import { botActivityCounter, drainBotHits } from "../../lib/botActivity.js";
import { timingSafeStringEqual } from "../../lib/auth.js";
import { limiterKey } from "../../lib/ip.js";
import { logInfo } from "../../lib/logger.js";
import {
  clearConfirmationFailures,
  cockpitPasswordLimiter,
  recordConfirmationFailure,
  refuseLockedOut,
} from "../../lib/cockpitAuth.js";
import { recordEventsReset } from "../../lib/autoHistory.js";
import { parseEditBody, refusesCockpitOrigin, refusesWrite } from "./guards.js";
import type { CockpitRouterDeps } from "../cockpit.js";

// The danger zone: Reset events and Reset database, each confirmed by
// typing the cockpit password again.

const resetSchema = z.strictObject({ password: z.string() });

// A session cookie is not the password, so a stolen cookie must not be
// a way to test guesses at it. Two limits: each wrong guess counts
// toward the sign-in lockout for its address (a 429, which cockpitFetch
// leaves alone), and five in a row from anywhere sign every session out
// (lib/cockpitAuth.ts). A wrong guess otherwise stays 403, for the
// reason below. The sign-out answers 401, because the session really
// is gone.
function confirmPassword(
  cockpitPassword: string,
  req: Request,
  res: Response,
  supplied: string,
): boolean {
  const ip = req.ip ?? "unknown";
  if (refuseLockedOut(cockpitPasswordLimiter, ip, res)) return false;
  if (!timingSafeStringEqual(supplied, cockpitPassword)) {
    cockpitPasswordLimiter.recordFailure(ip);
    if (recordConfirmationFailure()) {
      logInfo(
        "Too many wrong danger-zone passwords — every cockpit session was signed out",
        // Narrowed like the rate limiter's log, so an IPv6 address is
        // written as its /48 (docs/privacy.md, "The server log").
        { ip: limiterKey(ip) },
      );
      res.status(401).json({
        ok: false,
        error: "Too many wrong passwords. Every session was signed out.",
      });
      return false;
    }
    res.status(403).json({ ok: false, error: "Incorrect password." });
    return false;
  }
  clearConfirmationFailures();
  return true;
}

// Both danger-zone routes answer a wrong *confirmation* password with
// 403, never 401. The request is already authenticated — it carried a
// valid session to reach the handler — and it is the retyped
// confirmation that failed, which is an authorization answer, not an
// authentication one.
//
// Not a nicety: cockpit.js treats a 401 as "the session ran out" and
// sends the page to the login screen, so answering a mistyped
// confirmation with one would throw the owner out mid-confirmation.
// 401 is the session's answer, and nothing else's.

export function registerDangerRoutes(
  router: Router,
  deps: CockpitRouterDeps,
): void {
  const { db, timezone, cockpitPassword } = deps;
  // Puts the events directory back to the image's built-ins, discarding
  // every event this deployment added or edited. Gated like the database
  // reset — the password retyped — because it is the same kind of action:
  // irreversible from the browser, and destructive of work rather than of
  // test data.
  //
  // Stored rows are NOT touched. That is the point of the warning it
  // returns: removing an event type strands the rows it already
  // collected, which keep counting toward totals while matching no
  // registry-driven query (see lib/orphanedEvents.ts). The cockpit's
  // orphaned-events panel will report them on the next load anyway; this
  // says so at the moment it happens, when the person can still connect
  // cause and effect.
  router.post("/events/reset", parseEditBody, (req: Request, res: Response) => {
    if (refusesWrite(req, res, "A reset")) return;

    const body = resetSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Malformed request." });
      return;
    }

    if (!confirmPassword(cockpitPassword, req, res, body.data.password)) return;

    // Counted before the registry changes: afterwards these names are
    // gone from it, and what they collected is exactly what nothing
    // will be able to ask about any more.
    const storedBefore = getStoredEventCounts(db);

    const result = resetEvents();
    if (!result.ok) {
      res.status(500).json(result);
      return;
    }

    const reloaded = reloadEvents();
    if (!reloaded.ok) {
      res.status(500).json({
        ok: false,
        error:
          `The events directory was reset, but reloading it failed: ` +
          `${reloaded.error}`,
      });
      return;
    }

    const surviving = new Set(Object.keys(eventRegistry));
    const stranded = Object.entries(storedBefore)
      .filter(([name, count]) => count > 0 && !surviving.has(name))
      .map(([event, count]) => ({ event, count }))
      .sort((a, b) => b.count - a.count);

    recordEventsReset(result.removed.length, stranded, timezone);

    res.json({
      ok: true,
      removed: result.removed.length,
      eventCount: reloaded.eventCount,
      errorCount: reloaded.errors.length,
      stranded,
    });
  });

  // Wipes every stored event, rejected event and bot-activity row — the
  // cockpit's "danger zone" button, for clearing out test traffic before a
  // real launch. The event schema itself is untouched.
  //
  // Already sitting behind the same session as every other /cockpit
  // route, so this second password check is not the security boundary —
  // it exists so the button can't be fired by a stray click or a script
  // replaying an earlier action: the person has to type the password again,
  // right before the request that acts on it.
  router.post("/reset", parseEditBody, (req: Request, res: Response) => {
    if (
      refusesCockpitOrigin(
        req,
        res,
        "Reset must be requested from the cockpit page.",
      )
    ) {
      return;
    }

    const body = resetSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Malformed request." });
      return;
    }

    if (!confirmPassword(cockpitPassword, req, res, body.data.password)) return;

    const result = resetDatabase(db);
    // The in-memory bot-hit counter is a fourth place data lives besides
    // the three tables resetDatabase clears — left non-zero, the next
    // hourly flush (server/index.ts) would write it into a bot_activity
    // table this reset just emptied.
    drainBotHits(botActivityCounter);

    res.json({ ok: true, ...result });
  });
}
