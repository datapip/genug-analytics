import type { Request, Response, NextFunction } from "express";

// Applied to every response. Cheap, and correct regardless of route:
// nothing this server serves should ever be content-type-sniffed, and
// nothing should leak its URL as a referrer to another origin.
//
// HSTS too, so that after one visit a browser never tries this host over
// plain http, where someone on the same network could keep it there and
// read the cockpit password as it is typed. Sent on every response
// rather than only when req.secure says https, which is only as true as
// TRUST_PROXY: browsers ignore the header over http, so the only place it
// takes effect is the https it describes. This host only — no
// includeSubDomains, since the rest of the deployer's domain is not ours
// to pin — and no preload, which is a list a deployment opts into itself.
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
