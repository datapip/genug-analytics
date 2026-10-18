import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCountryLookup,
  parsePort,
  parseReadOnly,
  parseTimezone,
  parseTrustProxy,
  parseUpdateCheckEnabled,
  requireEnv,
} from "./env.js";
import { parseRetentionDays } from "./retention.js";
import { siteHost } from "./url.js";
import { parseLocalBackupsEnabled } from "./backup.js";

// Reads every setting once, at startup. A missing or invalid setting
// stops the server with an error: a server running with a setting nobody
// meant would give wrong numbers without anyone noticing. index.ts calls
// this first and passes the result on, so no other module reads these
// from the environment.
//
// A few optional settings are read where they are used, because many
// modules need them: EVENTS_PATH (the schema registry), CONTEXT_PATH
// (lib/context.ts), KEPT_QUERY_PARAMS and KEPT_HASH_VALUES (lib/url.ts)
// and GENUG_VERSION (lib/version.ts).
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // The docs tell owners to mount a persistent volume at `/data`, so
  // most deployments never set DB_PATH. Set it when running outside
  // Docker.
  const dbPath = env.DB_PATH ?? "/data/genug.db";
  const allowedOrigins = parseAllowedOrigins(requireEnv("ALLOWED_ORIGIN", env));
  return {
    allowedOrigins,
    siteHosts: siteHostsOf(allowedOrigins),
    timezone: parseTimezone(requireEnv("TIMEZONE", env)),
    mcpApiKey: requireEnv("MCP_API_KEY", env),
    cockpitPassword: requireEnv("COCKPIT_PASSWORD", env),
    readOnly: parseReadOnly(env.READ_ONLY),
    trustProxyHops: parseTrustProxy(env.TRUST_PROXY),
    port: parsePort(env.PORT),
    dbPath,
    // The folder of the database, on the same volume. It also holds the
    // daily salt, the cockpit's session salt and the local backups.
    dataDir: dirname(dbPath),
    // undefined keeps events forever (RETENTION_DAYS=-1).
    retentionDays: parseRetentionDays(env.RETENTION_DAYS),
    // Whether RETENTION_DAYS was unset, so index.ts can log that the
    // default applies.
    retentionDaysIsDefault: env.RETENTION_DAYS === undefined,
    localBackups: parseLocalBackupsEnabled(env.LOCAL_BACKUPS),
    updateCheck: parseUpdateCheckEnabled(env.UPDATE_CHECK),
    countryLookup: parseCountryLookup(env.COUNTRY_LOOKUP),
    // Where scripts/fetch-country-data.mjs saves the table in the image.
    // Can be set to use a table kept elsewhere.
    countryDataDir:
      env.COUNTRY_DATA_DIR ??
      fileURLToPath(new URL("../../country-data/", import.meta.url)),
  };
}

export type Config = ReturnType<typeof loadConfig>;

// A comma-separated list of origins, because a site can have several
// (example.com plus www.example.com, a staging host) and one installation
// can collect for several sites. Each must match exactly; there are no
// wildcards.
//
// An empty list stops the server. requireEnv only checks that the
// variable is set. A wrong origin fails in the visitor's browser and
// leaves nothing in this server's logs, so it is worth catching here.
function parseAllowedOrigins(value: string): ReadonlySet<string> {
  const origins = new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
  if (origins.size === 0) {
    throw new Error(
      "ALLOWED_ORIGIN must name at least one origin (comma-separated for more than one)",
    );
  }
  return origins;
}

// The sites the origins belong to, in siteHost's form (lib/url.ts).
// /events only stores urls on these hosts. An entry that isn't a valid
// origin stops the server rather than quietly matching nothing.
function siteHostsOf(origins: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(
    [...origins].map((origin) => {
      const host = siteHost(origin);
      if (host === "") {
        throw new Error(
          `ALLOWED_ORIGIN entry "${origin}" is not an origin such as https://example.com`,
        );
      }
      return host;
    }),
  );
}
