export function requireEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

// A bad value stops the server at startup instead of listening on an
// invalid port.
export function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535, got: ${value}`,
    );
  }
  return port;
}

// How many reverse proxies sit in front of this server. The
// X-Forwarded-For header is just text the sender writes, so trusting it
// without a proxy would let anyone fake a different req.ip on every
// request and get around every rate limit, including the cockpit's
// password lockout. The default, 0, trusts nobody, which is safe when the
// port is reachable directly.
export function parseTrustProxy(value: string | undefined): number {
  // An empty value (`TRUST_PROXY=` in a compose file) means unset. Checked
  // explicitly rather than relying on Number("") being 0.
  if (value === undefined || value === "") return 0;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error(
      `TRUST_PROXY must be an integer between 0 and 10, got: ${value}`,
    );
  }
  return hops;
}

// For a deployment whose MCP key is public, like the demo on the product
// website: every write is turned off, so no visitor can delete the
// demo's data. Unset or "false" is off, "true" is on, and anything else
// stops the server: a typo like "ture" that quietly meant "off" would
// leave the delete tool open on a public key.
export function parseReadOnly(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`READ_ONLY must be "true" or "false", got: ${value}`);
}

// /mcp has no lockout (lib/mcpAuth.ts), so a long key is what makes
// guessing it impossible. Length doesn't prove randomness, but it catches
// keys like "password" or "dev-key". Only a warning: an update must not
// stop a running deployment over a key that has worked so far. A
// READ_ONLY key is public on purpose, so there is no warning for it.
export const MIN_MCP_API_KEY_LENGTH = 32;

export function shortMcpApiKeyWarning(
  value: string,
  readOnly: boolean,
): string | undefined {
  if (readOnly || value.length >= MIN_MCP_API_KEY_LENGTH) return undefined;
  return (
    `MCP_API_KEY is ${value.length} characters. Use at least ${MIN_MCP_API_KEY_LENGTH}, ` +
    "or it can be guessed. Generate one with: openssl rand -hex 32"
  );
}

// The time zone that decides where days and hours start
// (lib/timezone.ts). Required, with no default: defaulting to UTC would
// quietly put events on the wrong day. Only named zones such as
// "Europe/Berlin" are accepted. A fixed offset like "+01:00" is refused,
// because it is wrong for half the year wherever clocks change. Returns
// the standard spelling, since "europe/berlin" is accepted too.
export function parseTimezone(value: string): string {
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    canonical = "";
  }
  const zones = Intl.supportedValuesOf("timeZone");
  if (canonical !== "UTC" && !zones.includes(canonical)) {
    const suggestion = suggestTimezone(value, zones);
    throw new Error(
      `TIMEZONE must be an IANA time zone name such as Europe/Berlin or UTC, got: ${value}.` +
        (suggestion ? ` Did you mean ${suggestion}?` : "") +
        ` The full list is the "TZ identifier" column of ${TIMEZONE_LIST_URL}`,
    );
  }
  return canonical;
}

export const TIMEZONE_LIST_URL =
  "https://en.wikipedia.org/wiki/List_of_tz_database_time_zones";

// The usual mistake is a city without its region ("Berlin", "new york"),
// so match the city part, ignoring case, spaces and underscores. A
// suggestion is only made when exactly one zone matches, so it can't
// point someone to the wrong one.
function suggestTimezone(
  value: string,
  zones: readonly string[],
): string | undefined {
  const key = (text: string) => text.toLowerCase().replace(/[\s_]/g, "");
  const wanted = key(value);
  if (wanted === "") return undefined;
  const matches = zones.filter(
    (zone) => key(zone) === wanted || key(zone.split("/").pop()!) === wanted,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

// One request a day to GitHub's tags API (lib/updateCheck.ts), so the
// cockpit can say when a newer version exists. On by default. Without
// internet access it just fails quietly, but this switch lets an owner
// turn it off without a firewall rule.
export function parseUpdateCheckEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`UPDATE_CHECK must be "true" or "false", got: ${value}`);
}

// Off unless set to "true": it stores something the site's privacy
// notice has to mention (docs/privacy.md), so an update must never turn
// it on by itself. A misspelled value stops the server, as for
// READ_ONLY.
export function parseCountryLookup(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`COUNTRY_LOOKUP must be "true" or "false", got: ${value}`);
}
