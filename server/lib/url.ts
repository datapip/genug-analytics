export interface ParsedUrl {
  path: string;
  params: string; // query string, without the leading "?"; "" if none
  hash: string; // fragment, without the leading "#"; "" if none
  host: string; // hostname only, no port; "" on a parse failure
}

// The fallback is not dead code, even though envelope.url is validated
// as a real URL at ingestion (see schema-registry/envelope.ts): this is
// also called on `referrer`, which is deliberately NOT URL-validated,
// because document.referrer is "" for a direct visitor — the common
// case, not an error. getTopReferrers relies on an unparseable referrer
// landing in the direct-traffic bucket rather than throwing, so on a
// parse failure the raw value becomes the "path" as-is.
// Query parameters worth keeping on a stored URL.
const KEPT_QUERY_PARAMS =
  /^(utm_(?:source|medium|campaign|term|content|id)|gclid|fbclid|msclkid|ttclid|ref|source)$/i;

// The read side of the allowlist: a query over a parameter that was
// never stored would silently match nothing, so the MCP layer refuses
// it by name and lists these instead.
export const KEPT_QUERY_PARAM_NAMES = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "ttclid",
  "ref",
  "source",
] as const;

export function isKeptQueryParam(name: string): boolean {
  return KEPT_QUERY_PARAMS.test(name);
}

// Drops every query parameter except the campaign and click-id ones
// above.
//
// A stored URL is read back verbatim by get_recent_events and shown in
// the cockpit, so whatever sits in a query string ends up in front of
// whoever asks — and for a hosted assistant, inside that vendor's API.
// Real sites put things there that have no business being collected: a
// newsletter link carries ?email=, a password reset or magic link
// carries a single-use token, a search page carries whatever the visitor
// typed. None of it is needed to rank pages, which group by path anyway.
//
// An allowlist, not a denylist of known-dangerous names, because the two
// fail in opposite directions. Forgetting to allow a parameter loses
// analytics data, which is visible the moment you look for it and
// fixable from then on. Forgetting to deny one leaks a token silently
// and irreversibly, because it is already stored and already sent.
//
// The client strips the same set before sending, so this is the backstop
// for anything POSTing to /events directly rather than the only line of
// defence. The two lists are necessarily separate copies: the client is
// an import-free classic script and cannot import this module.
export function stripUnknownParams(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Same fallback as parseUrl below: `referrer` is deliberately not
    // URL-validated, because "" is the normal value for a direct
    // visitor. An unparseable value passes through untouched.
    return rawUrl;
  }
  // Snapshotted before deleting, since deleting mutates what keys()
  // iterates. Deleting a key removes all of its values at once, so a
  // repeated parameter is handled by the first pass.
  for (const key of [...url.searchParams.keys()]) {
    if (!KEPT_QUERY_PARAMS.test(key)) url.searchParams.delete(key);
  }
  // The other half of the same channel, and the one the allowlist above
  // was silently letting through. An OAuth implicit response puts
  // access_token and id_token in the fragment precisely so they stay
  // out of server logs; some reset and unsubscribe flows do the same.
  // Nothing here reads a fragment — get_top_pages groups by path — so
  // dropping it costs no question an answer.
  url.hash = "";
  return url.toString();
}

export function parseUrl(rawUrl: string): ParsedUrl {
  try {
    const url = new URL(rawUrl);
    return {
      path: url.pathname,
      params: url.search.slice(1),
      hash: url.hash.slice(1),
      host: url.hostname,
    };
  } catch {
    return { path: rawUrl, params: "", hash: "", host: "" };
  }
}
