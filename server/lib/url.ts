export interface ParsedUrl {
  path: string;
  params: string; // query string, without the leading "?"; "" if none
  hash: string; // fragment, without the leading "#"; "" if none
  host: string; // hostname only, no port; "" on a parse failure
}

// What survives on a stored URL: which query parameters, and which
// fragments. "*" keeps every one; a list keeps only those. Parameter
// names are held lowercased and matched case-insensitively, as a
// hand-typed utm_Source is plainly the same parameter. Fragments are
// matched exactly, as the id an anchor points at is case-sensitive.
export type KeptValues = "*" | readonly string[];

export interface KeptUrlParts {
  params: KeptValues;
  hashes: KeptValues;
}

// Campaign parameters only. Click ids (gclid, fbclid, ...) are left out:
// each one ties a visit to a single ad click on the ad platform's side,
// which is more than ranking campaigns needs. A deployment that wants
// them names them in KEPT_QUERY_PARAMS.
export const DEFAULT_KEPT_QUERY_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
] as const;

// Whole values only, no globs. "utm_*" reads as convenient, but it
// would also keep utm_email= and utm_token=, which a real newsletter
// tool will happily generate — the allowlist is only safe because every
// name on it was written down by someone. "*" alone is the one wildcard,
// and it means everything, on purpose.
function parseKeptList(
  name: string,
  value: string | undefined,
  fallback: KeptValues,
  normalize: (entry: string) => string,
): KeptValues {
  // Bare `NAME=` in a compose file means unset, same as TRUST_PROXY.
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

// Unset keeps no fragment, as before this was configurable: an OAuth
// implicit response puts access_token and id_token in the fragment
// precisely so they stay out of server logs, and some reset and
// unsubscribe flows do the same. A leading "#" is accepted and dropped,
// since that is how an anchor is usually written down.
export function parseKeptHashValues(value: string | undefined): KeptValues {
  return parseKeptList("KEPT_HASH_VALUES", value, [], (e) =>
    e.startsWith("#") ? e.slice(1) : e,
  );
}

// Read once at startup: a bad value throws on import, which stops the
// server before it stores a single URL under a list nobody meant.
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

// The read side of the allowlist, for tool descriptions and refusals: a
// query over a parameter that was never stored would silently match
// nothing, so the MCP layer refuses it by name and lists these instead.
export function describeKeptQueryParams(
  parts: KeptUrlParts = keptUrlParts,
): string {
  if (parts.params === "*") {
    return "any parameter — this deployment keeps them all";
  }
  return parts.params.length === 0 ? "none" : parts.params.join(", ");
}

// Drops every query parameter and fragment the lists above don't keep.
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
// The client strips with the same lists before sending — the server
// writes them into client.js as it serves it (lib/clientScript.ts) — so
// this is the backstop for anything POSTing to /events directly, and for
// a browser still running a cached copy from before the lists changed.
export function stripUnknownParams(
  rawUrl: string,
  parts: KeptUrlParts = keptUrlParts,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    // Same fallback as parseUrl below. The envelope lets `referrer`
    // through as "", the normal value for a direct visitor, and that
    // passes through untouched.
    return rawUrl;
  }
  // Snapshotted before deleting, since deleting mutates what keys()
  // iterates. Deleting a key removes all of its values at once, so a
  // repeated parameter is handled by the first pass.
  for (const key of [...url.searchParams.keys()]) {
    if (!isKeptQueryParam(key, parts)) url.searchParams.delete(key);
  }
  if (!keeps(parts.hashes, url.hash.slice(1))) url.hash = "";
  return url.toString();
}

// The fallback is not dead code, even though envelope.url is validated
// as a real URL at ingestion (see schema-registry/envelope.ts): this is
// also called on `referrer`, which is deliberately NOT URL-validated,
// because document.referrer is "" for a direct visitor — the common
// case, not an error. getTopReferrers relies on an unparseable referrer
// landing in the direct-traffic bucket rather than throwing, so on a
// parse failure the raw value becomes the "path" as-is.
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
