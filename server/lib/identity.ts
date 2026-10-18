import { createHmac } from "node:crypto";

// The visitor_id without consent: a hash of site + shortened IP address
// + User-Agent, keyed with the daily salt (lib/dailySalt.ts). When a
// visitor gives consent, the same hash becomes their cookie id, so they
// keep the same id (see "Consentless → consentful transition" in
// docs/decisions.md).
//
// The site (siteHost in lib/url.ts) is part of the hash so one person on
// two of the installation's sites is two visitors. Without it, the hash
// would link them across sites, which is the cross-site tracking this
// mode exists to avoid. The parts are joined with newlines, which none
// of them can contain.
export function consentlessVisitorId(
  site: string,
  ip: string,
  userAgent: string,
  salt: string,
): string {
  return createHmac("sha256", salt)
    .update(`${site}\n${ip}\n${userAgent}`)
    .digest("hex");
}

// The format consentlessVisitorId produces: a SHA-256 HMAC as 64
// lowercase hex characters.
const ISSUED_VISITOR_ID = /^[a-f0-9]{64}$/;

// Whether a value looks like a visitor_id this server issued.
//
// With consent, the visitor_id comes from a cookie. The cookie is
// httpOnly, so the page's JavaScript can't set it, but any HTTP client
// can send any Cookie header. Without this check, a script could send a
// new random value with every request to create unlimited fake visitors,
// with values of any length. A value that fails the check is ignored, as
// if no cookie had been sent.
export function isIssuedVisitorId(value: string): boolean {
  return ISSUED_VISITOR_ID.test(value);
}

// What the response must do with the visitor cookie. This module only
// returns the decision; routes/events.ts sets or clears the cookie. That
// keeps this module free of Express, so tests can check the decision
// directly.
export type VisitorCookieAction = "set" | "clear" | "none";

export type VisitorIdentity = {
  visitorId: string;
  consentful: boolean;
  cookie: VisitorCookieAction;
};

// Decides who sent this request, and whether they are identified by
// their consent cookie or by today's hash. It only uses the request's
// consent value, its visitor cookie and the inputs of the hash, so it
// is a pure function.
export function resolveVisitorIdentity(input: {
  // true, false, or not sent (undefined). False and not sent are
  // treated differently below.
  consent: boolean | undefined;
  // The cookie value exactly as the request sent it, not yet checked.
  visitorCookie: string | undefined;
  site: string;
  ip: string;
  userAgent: string | undefined;
  salt: string;
}): VisitorIdentity {
  const { consent, visitorCookie, site, ip, userAgent, salt } = input;

  // A cookie that doesn't look like one this server issued is ignored
  // (see isIssuedVisitorId).
  const existingCookie =
    visitorCookie && isIssuedVisitorId(visitorCookie)
      ? visitorCookie
      : undefined;

  if (consent === false) {
    // The visitor said no. Any cookie is ignored and deleted: GDPR
    // Art. 7(3) says withdrawing consent must be as easy as giving it,
    // which means removing the identifier. The cookie is httpOnly, so
    // the site's JavaScript can't delete it; only this response can. It
    // is deleted even if invalid, since it is still stored on the
    // device.
    return {
      visitorId: consentlessVisitorId(site, ip, userAgent ?? "", salt),
      consentful: false,
      cookie: visitorCookie ? "clear" : "none",
    };
  }

  // Consent is true, or not sent (the consent banner hasn't answered
  // yet on this request, or the site has no banner). Either way an
  // existing cookie is used: it exists only because this browser
  // consented before, and only an explicit `false` removes it. So a
  // returning visitor's first page view, sent before the banner has
  // loaded, still counts under their id. See "Visitor identification"
  // in docs/decisions.md.
  const visitorId =
    existingCookie ?? consentlessVisitorId(site, ip, userAgent ?? "", salt);
  // A visitor with no cookie and no answer gets today's hash, and no
  // cookie is set. One who just said yes gets a cookie holding today's
  // hash, not a random id (see "Consentless → consentful transition" in
  // docs/decisions.md).
  //
  // Only an explicit yes writes the cookie, so only a yes extends its 13
  // months. A request without an answer reads the cookie (see above) but
  // doesn't set it again: that would store an identifier on the device
  // without consent on this request (§ 25(1) TDDDG). A consent banner
  // that repeats the stored consent on every page load keeps a regular
  // visitor's cookie alive; one that only reports the accept click lets
  // it expire 13 months later.
  const consentful = existingCookie !== undefined || consent === true;
  return {
    visitorId,
    consentful,
    cookie: consent === true ? "set" : "none",
  };
}
