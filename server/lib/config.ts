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
import { parseLocalBackupsEnabled } from "./backup.js";

// Every setting the server is started with, read once, in one place,
// and refused loudly when it is missing or malformed: a deployment that
// comes up with a setting it did not mean is subtly wrong, not visibly
// broken. index.ts calls this first and hands the result to everything
// it builds, so no other module reads the environment for these.
//
// A few settings are still read where they are used, because many
// modules share them and none of them is required: EVENTS_PATH (the
// schema registry, whose loaded events are live bindings),
// CONTEXT_PATH (lib/context.ts), KEPT_QUERY_PARAMS and KEPT_HASH_VALUES
// (lib/url.ts) and GENUG_VERSION (lib/version.ts).
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // `/data` is where the Docker and Coolify docs tell the operator to
  // mount a persistent volume, so most deployments never set DB_PATH.
  // Overridable for running outside Docker.
  const dbPath = env.DB_PATH ?? "/data/genug.db";
  return {
    allowedOrigins: parseAllowedOrigins(requireEnv("ALLOWED_ORIGIN", env)),
    timezone: parseTimezone(requireEnv("TIMEZONE", env)),
    mcpApiKey: requireEnv("MCP_API_KEY", env),
    cockpitPassword: requireEnv("COCKPIT_PASSWORD", env),
    readOnly: parseReadOnly(env.READ_ONLY),
    trustProxyHops: parseTrustProxy(env.TRUST_PROXY),
    port: parsePort(env.PORT),
    dbPath,
    // Beside the database, on the same volume: the daily salt, the
    // cockpit's session salt and the local backups.
    dataDir: dirname(dbPath),
    // undefined keeps events forever (RETENTION_DAYS=-1).
    retentionDays: parseRetentionDays(env.RETENTION_DAYS),
    // Unset falls back to a default rather than to forever, which is
    // worth saying at startup: see index.ts.
    retentionDaysIsDefault: env.RETENTION_DAYS === undefined,
    localBackups: parseLocalBackupsEnabled(env.LOCAL_BACKUPS),
    updateCheck: parseUpdateCheckEnabled(env.UPDATE_CHECK),
    countryLookup: parseCountryLookup(env.COUNTRY_LOOKUP),
    // Where scripts/fetch-country-data.mjs puts the table, which is
    // where the image has it. Overridable for a table kept elsewhere.
    countryDataDir:
      env.COUNTRY_DATA_DIR ??
      fileURLToPath(new URL("../../country-data/", import.meta.url)),
  };
}

export type Config = ReturnType<typeof loadConfig>;

// A comma-separated list, because one site legitimately has more than
// one origin: an apex plus a `www.` host that doesn't redirect, or a
// staging host reporting to the same collector. Every entry still has to
// match exactly — this widens the set of known origins, it never relaxes
// into a wildcard or an echo-anything policy.
//
// An empty result fails: requireEnv only proves the variable is set, not
// that it holds an origin. It matters more here than elsewhere because
// an unlisted origin fails inside the browser, which leaves no trace in
// this server's logs at all.
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
