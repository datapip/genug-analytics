export interface ParsedUrl {
  path: string;
  params: string; // query string, without the leading "?"; "" if none
  hash: string; // fragment, without the leading "#"; "" if none
  host: string; // hostname only, no port; "" on a parse failure
}

// Which query parameters and fragments are kept on a stored URL. "*"
// keeps all of them; a list keeps only those. Parameter names are stored
// lowercase and matched ignoring case, since a hand-typed utm_Source is
// the same parameter. Fragments must match exactly, because anchor ids
// are case-sensitive.
export type KeptValues = "*" | readonly string[];

export interface KeptUrlParts {
  params: KeptValues;
  hashes: KeptValues;
}

// Only the campaign parameters by default. Click ids (gclid, fbclid, ...)
// are left out: each one links a visit to one specific ad click at the
// ad platform, which is more than comparing campaigns needs. A deployment
// that wants them adds them to KEPT_QUERY_PARAMS.
export const DEFAULT_KEPT_QUERY_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
] as const;

// Exact names only, no patterns. "utm_*" would be convenient but would
// also keep utm_email= or utm_token=, which some newsletter tools add.
// The list is only safe because someone wrote down every name on it. A
// lone "*" is the only wildcard, and it means "keep everything".
function parseKeptList(
  name: string,
  value: string | undefined,
  fallback: KeptValues,
  normalize: (entry: string) => string,
): KeptValues {
  // An empty `NAME=` in a compose file means unset, as for TRUST_PROXY.
  if (value === undefined || value.trim() === "") return fallback;
  const entries = value.split(",").map((entry) => normalize(entry.trim()));
  if (entries.length === 1 && entries[0] === "*") return "*";
  for (const entry of entries) {
    if (!/^[^\s,*]+$/.test(entry)) {
      throw new Error(
        `${name} must be "*" or a comma-separated list of exact values (no spaces, no wildcards), got: ${value}`,
      );
    }
  }
  return [...new Set(entries)];
}

export function parseKeptQueryParams(value: string | undefined): KeptValues {
  return parseKeptList(
    "KEPT_QUERY_PARAMS",
    value,
    DEFAULT_KEPT_QUERY_PARAMS,
    (e) => e.toLowerCase(),
  );
}

// Unset keeps no fragment. Some login flows (OAuth) put access tokens in
// the fragment precisely to keep them out of server logs, and some
// password-reset and unsubscribe links do the same. A leading "#" is
// accepted and removed, since anchors are often written that way.
//
// Each entry is encoded by the URL parser, the same way the fragment it
// is compared with was encoded: #über arrives as #%C3%BCber, so a
// hand-written "über" would otherwise never match. An entry that is
// already encoded stays as it is. Spaces are not encoded, so the list
// check still rejects them: "pricing faq" is a missing comma, not a
// fragment.
export function parseKeptHashValues(value: string | undefined): KeptValues {
  return parseKeptList("KEPT_HASH_VALUES", value, [], (e) => {
    const bare = e.startsWith("#") ? e.slice(1) : e;
    if (/\s/.test(bare)) return bare;
    return new URL("http://x/#" + bare).hash.slice(1);
  });
}

// Read once at startup. A bad value throws when this module loads, so
// the server stops before storing any URL with the wrong list.
export const keptUrlParts: KeptUrlParts = {
  params: parseKeptQueryParams(process.env.KEPT_QUERY_PARAMS),
  hashes: parseKeptHashValues(process.env.KEPT_HASH_VALUES),
};

function keeps(kept: KeptValues, value: string): boolean {
  return kept === "*" || kept.includes(value);
}

export function isKeptQueryParam(
  name: string,
  parts: KeptUrlParts = keptUrlParts,
): boolean {
  return keeps(parts.params, name.toLowerCase());
}

// The kept parameters, for tool descriptions and error messages. A
// query about a parameter that is never stored would match nothing, so
// the MCP tools refuse it and list these instead.
export function describeKeptQueryParams(
  parts: KeptUrlParts = keptUrlParts,
): string {
  if (parts.params === "*") {
    return "any parameter — this deployment keeps them all";
  }
  return parts.params.length === 0 ? "none" : parts.params.join(", ");
}

// Removes every query parameter and fragment the lists above don't keep.
//
// Stored URLs are shown as they are, by get_recent_events and in the
// cockpit, and for a hosted AI assistant they are sent to its vendor.
// Real sites put things in query strings that shouldn't be collected: a
// newsletter link has ?email=, a password-reset link has a one-time
// token, a search page has whatever the visitor typed. Pages are grouped
// by path anyway, so none of it is needed.
//
// It keeps a list of allowed names instead of removing known-dangerous
// ones, because the mistakes differ. Forgetting to allow a parameter
// loses some analytics data, which is easy to notice and fix. Forgetting
// to block one stores a secret, and that can't be undone.
//
// The client script already removes them with the same lists (the
// server writes the lists into client.js, see lib/clientScript.ts).
// This is the safety net for requests sent to /events directly and for
// browsers with an old cached copy of the script.
export function stripUnknownParams(
  rawUrl: string,
  parts: KeptUrlParts = keptUrlParts,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Same fallback as parseUrl below. `referrer` is "" for a direct
    // visitor, which is returned unchanged.
    return rawUrl;
  }
  // Copy the keys first, because deleting while looping over keys()
  // would skip some. Deleting a key removes all its values, so a
  // repeated parameter is handled at once.
  for (const key of [...url.searchParams.keys()]) {
    if (!isKeptQueryParam(key, parts)) url.searchParams.delete(key);
  }
  if (!keeps(parts.hashes, url.hash.slice(1))) url.hash = "";
  // A `user:pass@` part is a login, not part of the page. Browsers
  // usually remove it, but a request sent directly could contain one.
  url.username = "";
  url.password = "";
  return url.toString();
}

// The fallback is needed: `url` is checked when an event arrives, but
// `referrer` isn't, because it is "" for every direct visitor. So when
// parsing fails, the raw value becomes the "path", and getTopReferrers
// counts an unparseable referrer as direct traffic instead of throwing.
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

// example.com and www.example.com count as one site. Only `www` is
// removed: treating blog.example.com and shop.example.com as one site
// would need the public suffix list (to tell subdomains from separate
// domains), and that would be a new dependency.
export function bareHost(host: string): string {
  return host.replace(/^www\./i, "").toLowerCase();
}

// The site a page belongs to. One installation may collect for several
// sites of one owner (ALLOWED_ORIGIN), and the page's host tells them
// apart. The visitor hash, the session and the host segment all use this
// function, so they always agree on a session's site. An unparseable url
// gives "".
export function siteHost(rawUrl: string): string {
  return bareHost(parseUrl(rawUrl).host);
}
