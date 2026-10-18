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

// The danger zone: Reset events and Reset database. Each needs the
// cockpit password typed again.

const resetSchema = z.strictObject({ password: z.string() });

// Someone with a stolen session cookie must not be able to use this
// password box to guess the password. So each wrong password counts
// toward the sign-in lockout for its address (answered 429, which
// cockpitFetch passes through), and five wrong in a row from anywhere
// sign every session out (lib/cockpitAuth.ts), answered 401 because the
// session really is gone. Otherwise a wrong password gets 403 (see
// below).
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
        // Shortened like in the rate limiter's log: an IPv6 address is
        // logged as its /48 (docs/privacy.md, "The server log").
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

// A wrong confirmation password gets 403, never 401. The request has a
// valid session; only the retyped password was wrong. cockpit.js treats
// every 401 as "the session ran out" and shows the sign-in page, so a
// 401 here would throw the owner out for a typo.

export function registerDangerRoutes(
  router: Router,
  deps: CockpitRouterDeps,
): void {
  const { db, timezone, cockpitPassword } = deps;
  // Resets the events folder to the built-in events, discarding every
  // event this deployment added or edited. Like the database reset it
  // needs the password, because it can't be undone from the browser.
  //
  // Stored rows are kept. Rows of removed events stay in totals but match
  // no event any more (see lib/orphanedEvents.ts). The cockpit reports
  // them on the next load anyway; the warning returned here says so
  // right away, when the owner can still connect cause and effect.
  router.post("/events/reset", parseEditBody, (req: Request, res: Response) => {
    if (refusesWrite(req, res, "A reset")) return;

    const body = resetSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ ok: false, error: "Malformed request." });
      return;
    }

    if (!confirmPassword(cockpitPassword, req, res, body.data.password)) return;

    // Count the rows before the events change, while the old names are
    // still known.
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

  // Deletes every stored event, rejected event and bot-activity row, to
  // clear test traffic before launch. The event definitions are kept.
  //
  // The route already needs a session like every /cockpit route. The
  // second password check is there so a stray click or a replayed
  // request can't trigger it: the owner must type the password right
  // before.
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
    // Also reset the bot counter in memory. Otherwise the next hourly
    // save (server/index.ts) would write its count into the bot_activity
    // table that was just emptied.
    drainBotHits(botActivityCounter);

    res.json({ ok: true, ...result });
  });
}
