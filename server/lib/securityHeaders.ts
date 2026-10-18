import type { Request, Response, NextFunction } from "express";

// Headers for every response: browsers must not guess a content type, and
// no URL from this server is sent as the referrer to other sites.
//
// HSTS makes a browser use https for this host after one visit, so nobody
// on the same network can keep it on plain http and read the cockpit
// password. It is sent on every response, not only when req.secure says
// https (which depends on TRUST_PROXY being right); browsers ignore it
// over http anyway. It covers this host only: no includeSubDomains,
// because the rest of the owner's domain isn't ours to decide, and no
// preload, which a deployment has to sign up for itself.
const HSTS = "max-age=31536000";

export function baseSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", HSTS);
  next();
}

// The Content-Security-Policy for the cockpit, the only HTML this server
// serves. "Security headers" in docs/decisions.md explains each rule.
// style-src needs 'unsafe-inline' because cockpit.js sets style
// attributes it computes at runtime (a bar's width, a line's colour).
// script-src doesn't: the page has no inline script.
const COCKPIT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export function cockpitSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("Content-Security-Policy", COCKPIT_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  next();
}
