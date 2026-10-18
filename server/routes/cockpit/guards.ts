import { json, type Request, type Response } from "express";
import { eventsPath, eventsSource } from "@genug/schema-registry";

// The checks the cockpit's write routes share, kept in one place so the
// routes in data, events, context and danger cannot drift apart on them.

// Long enough for a sentence explaining a rename, short enough that the
// entry it lands in stays inside the history log's own 2000-character
// note cap with both event names in front of it.
export const REASON_MAX_LENGTH = 500;

// The body limit for every write except the two prose fields
// (cockpit/context.ts), which can be much longer.
export const parseEditBody = json({ limit: "64kb" });

// Half the CSRF defence for every write on the cockpit router. The
// other half is the session cookie, which is SameSite=Lax, so a browser
// will not send it on a cross-site POST at all. Both, because the two
// fail differently: a header no plain form can set forces a preflight,
// and /cockpit answers no CORS preflight.
//
// Shared by every write route — including reload and the resets,
// which need nothing else refusesWrite checks — so the comparison and
// the response shape can't drift out of step between them. `message`
// keeps each call site's own wording; only the check and the 400
// itself are shared.
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

// The two gates every write to an event *file* passes (on top of the
// CSRF check above, which every write on the router passes), kept in
// one place so they cannot drift apart: a route that forgot the second
// would accept a save that the next deploy throws away. Returns true
// when it has already answered the request.
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
