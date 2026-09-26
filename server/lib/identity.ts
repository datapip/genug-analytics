import { createHmac } from "node:crypto";

// Consentless visitor_id: a hash of IP + User-Agent, keyed by the daily
// salt (lib/dailySalt.ts). Also used to compute the "frozen" value on the consentless →
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
// real visitor's id is impractical (it's an HMAC keyed by the daily salt),
// but sending a fresh random value per request was a free way to
// manufacture unlimited distinct "visitors" and sessions, at unbounded
// string length per row. A value that fails this check is ignored and
// the request falls through to the derived hash, exactly as if no
// cookie had been sent.
export function isIssuedVisitorId(value: string): boolean {
  return ISSUED_VISITOR_ID.test(value);
}

// What the response must do with the visitor cookie once the identity is
// decided. Returned rather than done here, because this module knows
// nothing about the cookie's name, its lifetime or the response — and a
// unit test can read a decision, where it would have to fake express to
// watch a side effect.
export type VisitorCookieAction = "set" | "clear" | "none";

export type VisitorIdentity = {
  visitorId: string;
  consentful: boolean;
  cookie: VisitorCookieAction;
};

// Who this request belongs to, and whether they are identified by a
// cookie they consented to or by the day's ephemeral hash. The only
// inputs are the request's own consent signal, whatever visitor cookie
// it carried, and what the consentless hash is made of — so the whole
// decision is one pure function with no express in it.
export function resolveVisitorIdentity(input: {
  // Explicitly true, explicitly false, or not sent at all — three
  // states, and the difference between the last two is load-bearing below.
  consent: boolean | undefined;
  // The raw cookie value exactly as the request sent it, unvalidated.
  visitorCookie: string | undefined;
  ip: string;
  userAgent: string | undefined;
  salt: string;
}): VisitorIdentity {
  const { consent, visitorCookie, ip, userAgent, salt } = input;

  // A cookie that doesn't look like one this server issued is ignored
  // rather than trusted — see isIssuedVisitorId.
  const existingCookie =
    visitorCookie && isIssuedVisitorId(visitorCookie)
      ? visitorCookie
      : undefined;

  if (consent === false) {
    // An explicit "no" — not merely absent. A cookie is never trusted
    // here even if one was sent, and is removed if present: Art. 7(3)
    // ("as easy to withdraw as to give") requires actually removing the
    // identifier, and since the cookie is httpOnly, the tracked site's
    // own JavaScript cannot delete it — only this response can. The
    // clear is keyed on the raw value, not the validated one: a
    // malformed cookie is still an identifier sitting on the device.
    return {
      visitorId: consentlessVisitorId(ip, userAgent ?? "", salt),
      consentful: false,
      cookie: visitorCookie ? "clear" : "none",
    };
  }

  // consent === true, or not sent at all (a consent manager that
  // hasn't answered yet on this particular request, or a deployment
  // with no banner). Either way, a cookie already on the request
  // wins: its mere presence already proves this browser consented
  // before, and only an explicit `false` above removes that trust.
  // This is what closes the race an unanswered auto page-view used to
  // lose — it no longer clears a returning, already-consented
  // visitor's cookie just because this one request doesn't (yet)
  // confirm it. See "Visitor identification" in docs/decisions.md.
  const visitorId =
    existingCookie ?? consentlessVisitorId(ip, userAgent ?? "", salt);
  // A visitor with no cookie who also hasn't answered gets the
  // ordinary ephemeral hash and nothing is set below. One who just
  // said yes gets a fresh persistent cookie frozen from today's hash
  // rather than a random UUID (see "Consentless → consentful
  // transition").
  const consentful = existingCookie !== undefined || consent === true;
  return { visitorId, consentful, cookie: consentful ? "set" : "none" };
}
