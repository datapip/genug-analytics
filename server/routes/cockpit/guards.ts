import { json, type Request, type Response } from "express";
import { eventsPath, eventsSource } from "@genug/schema-registry";

// Checks shared by the cockpit's write routes, kept in one place so
// every route does them the same way.

// Long enough for a sentence explaining a rename, and short enough that
// the history entry (with both event names added) stays under the
// history log's 2000-character limit.
export const REASON_MAX_LENGTH = 500;

// The body limit for every write except the two prose fields
// (cockpit/context.ts), which can be much longer.
export const parseEditBody = json({ limit: "64kb" });

// One of two protections against cross-site request forgery (CSRF) for
// every cockpit write. The other is the session cookie's SameSite=Lax,
// which stops the browser sending it on a cross-site POST. This one
// requires a custom header: a plain HTML form can't set one, and another
// site's script would need a CORS preflight, which /cockpit never
// allows. Two protections, because they can fail in different ways.
//
// `message` lets each route word its own error.
export function refusesCockpitOrigin(
  req: Request,
  res: Response,
  message: string,
): boolean {
  if (req.get("x-genug-cockpit") !== "1") {
    res.status(400).json({ ok: false, error: message });
    return true;
  }
  return false;
}

// The two checks every write to an event file needs, on top of the CSRF
// check above. A route that skipped the second would accept a change
// that the next deploy throws away. Returns true when it has already
// sent the response.
export function refusesWrite(
  req: Request,
  res: Response,
  action: string,
): boolean {
  if (
    refusesCockpitOrigin(
      req,
      res,
      `${action} must be saved from the cockpit page.`,
    )
  ) {
    return true;
  }

  if (eventsSource !== eventsPath) {
    res.status(409).json({
      ok: false,
      error:
        `Events are being read from the image, not from ${eventsPath}, so ` +
        `a change made here could not persist. The Schema registry card ` +
        `lists the reason.`,
    });
    return true;
  }

  return false;
}
