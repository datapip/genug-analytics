import { createHmac } from "node:crypto";

// HMAC of the current date (YYYY-MM-DD), keyed by SALT_SECRET — rotates
// daily without persisting any per-visitor state.
export function dailySalt(secret: string, date: Date): string {
  const day = date.toISOString().slice(0, 10);
  return createHmac("sha256", secret).update(day).digest("hex");
}

// Consentless visitor_id: a hash of IP + User-Agent, keyed by the daily
// salt. Also used to compute the "frozen" value on the consentless →
// consentful transition (see Data model docs) — same inputs, same hash.
export function consentlessVisitorId(
  ip: string,
  userAgent: string,
  salt: string,
): string {
  return createHmac("sha256", salt).update(`${ip}:${userAgent}`).digest("hex");
}

// Exactly the shape consentlessVisitorId produces above: a SHA-256 HMAC
// as lowercase hex.
const ISSUED_VISITOR_ID = /^[a-f0-9]{64}$/;

// Whether a value looks like a visitor_id this server actually issued.
//
// The consentful path reads visitor_id back from a cookie, and that
// cookie used to be trusted verbatim. It's httpOnly, so page JS can't
// set it — but any HTTP client can put whatever it likes in a Cookie
// header, and the value went straight into the database. Guessing a
// real visitor's id is impractical (it's an HMAC keyed by SALT_SECRET),
// but sending a fresh random value per request was a free way to
// manufacture unlimited distinct "visitors" and sessions, at unbounded
// string length per row. A value that fails this check is ignored and
// the request falls through to the derived hash, exactly as if no
// cookie had been sent.
export function isIssuedVisitorId(value: string): boolean {
  return ISSUED_VISITOR_ID.test(value);
}
