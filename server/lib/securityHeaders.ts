import type { Request, Response, NextFunction } from "express";

// Applied to every response. Cheap, and correct regardless of route:
// nothing this server serves should ever be content-type-sniffed, and
// nothing should leak its URL as a referrer to another origin.
export function baseSecurityHeaders(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

// The cockpit is the only HTML this server serves, so it's the only
// place a content policy means anything. See "Security headers" in
// docs/decisions.md for why each directive is what it is; the one
// worth knowing while editing this file is that style-src still needs
// 'unsafe-inline' because cockpit.js sets inline style *attributes* for
// values it computes at runtime (a bar's width, a series colour). script-src
// needs no such exemption — the page has no inline script at all.
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
