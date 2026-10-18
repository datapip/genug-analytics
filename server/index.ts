import { join } from "node:path";
import { eventsPath } from "@genug/schema-registry";
import { loadConfig } from "./lib/config.js";
import { openDatabase } from "./db/index.js";
import { createApp } from "./app.js";
import {
  pruneOldEvents,
  pruneOldRejectedEvents,
  pruneOldBotActivity,
} from "./lib/retention.js";
import { runBackup } from "./lib/backup.js";
import { shortMcpApiKeyWarning } from "./lib/env.js";
import { VERSION } from "./lib/version.js";
import { startUpdateCheck } from "./lib/updateCheck.js";
import { drainBotHits, botActivityCounter } from "./lib/botActivity.js";
import { insertBotActivity } from "./db/botActivity.js";
import { logInfo, logError } from "./lib/logger.js";
import { seedContextFiles, contextPath } from "./lib/context.js";
import { keptUrlParts } from "./lib/url.js";

// The server's entry point, and the only module that reads its settings
// from the environment: a missing or malformed one throws here, before
// anything is opened or listened on.
const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp({ config, db });

// Said once at startup: a read-only deployment is one whose MCP key is
// meant to be public, and the log is where an operator checks that the
// mode they configured is the mode that is running.
if (config.readOnly) {
  logInfo(
    "READ_ONLY is set — the writing tools (delete_visitor_data, add_history_note) and get_recent_events are not registered, and the cockpit refuses every edit, reload and reset. Collection on /events continues.",
  );
}

// Said for the same reason: it changes what every row stores, and the
// deployment's privacy notice has to say so (docs/privacy.md).
if (config.countryLookup) {
  logInfo(
    "COUNTRY_LOOKUP is on — each event stores the country of the shortened address, looked up on this server.",
  );
  // With no proxy trusted, a proxy in front is the address every
  // request comes from, and every visitor gets its country.
  if (config.trustProxyHops === 0) {
    logInfo(
      "COUNTRY_LOOKUP is on with TRUST_PROXY=0. If a reverse proxy sits in front of this server, every visitor gets the proxy’s country: set TRUST_PROXY to the number of proxies.",
    );
  }
}

const keyWarning = shortMcpApiKeyWarning(config.mcpApiKey, config.readOnly);
if (keyWarning) logInfo(keyWarning);

// Said once at startup, like READ_ONLY above: "*" is an operator's
// choice to make, but the log is where they check it is the one running
// — it lets a newsletter's ?email= and a reset link's token be stored,
// shown in the cockpit and read back to the agent.
for (const [name, kept] of [
  ["KEPT_QUERY_PARAMS", keptUrlParts.params],
  ["KEPT_HASH_VALUES", keptUrlParts.hashes],
] as const) {
  if (kept === "*") {
    logInfo(
      `${name} is "*" — every value is stored as the visitor's browser sent it, including any email address or token in it. List the values you need instead to keep the rest out.`,
    );
  }
}

// Puts the ground-rules and history files on the volume the first time,
// and never touches them again. A failure here is not fatal: the
// resource falls back to the built-in text and says so in the document
// itself, which is more use to whoever is reading an answer than a
// refusal to start would be.
const seededContext = seedContextFiles();
if (!seededContext.ok) {
  logError(
    `Could not prepare ${contextPath} — the agent will be served the built-in ground rules and told why`,
    seededContext.error,
  );
} else if (seededContext.created.length > 0) {
  logInfo("Wrote the default context files", {
    path: contextPath,
    files: seededContext.created,
  });
}

// Old events are pruned once at startup and then once a day — a plain
// setInterval is enough since this is already a single long-running
// process, no external cron needed.
const { retentionDays } = config;
if (config.retentionDaysIsDefault) {
  // Loud rather than quiet, though the default is a reasonable one: it
  // is how much data the prune below deletes, and an operator should
  // see that before it runs, not discover it after. See "Data
  // lifecycle" in docs/decisions.md.
  logInfo(
    `RETENTION_DAYS is not set — defaulting to ${retentionDays} days. Set RETENTION_DAYS=-1 to keep events forever instead, or a number of days to choose a different period.`,
  );
}
if (retentionDays !== undefined) {
  const runPrune = () => {
    try {
      pruneOldEvents(db, retentionDays);
      pruneOldRejectedEvents(db, retentionDays);
      pruneOldBotActivity(db, retentionDays);
    } catch (error) {
      logError("Retention pruning failed", error);
    }
  };
  runPrune();
  setInterval(runPrune, 24 * 60 * 60 * 1000);
}

// Flushes the in-memory bot-hit counter (routes/events.ts) to a single
// row once an hour — not once at startup too, unlike the jobs above,
// since there's nothing to flush yet on a fresh boot (drainBotHits
// would just return 0). Only writes a row when that hour actually saw
// bot traffic, so a quiet deployment never grows this table at all —
// see db/migrations.ts for why this isn't a row per bot hit.
const runBotActivityFlush = () => {
  try {
    const count = drainBotHits(botActivityCounter);
    if (count > 0) {
      insertBotActivity(db, new Date().toISOString(), count);
    }
  } catch (error) {
    logError("Bot activity flush failed", error);
  }
};
setInterval(runBotActivityFlush, 60 * 60 * 1000);

// Best-effort, off with UPDATE_CHECK=false — see lib/updateCheck.ts for
// why a failure here is silent rather than logged.
if (config.updateCheck) {
  startUpdateCheck(VERSION);
}

// Reclaims disk space freed by deleted rows (retention pruning above,
// or delete_visitor_data via MCP) a little at a time — see
// db/migrations.ts for why auto_vacuum is INCREMENTAL rather than a
// full VACUUM. Runs unconditionally, unlike retention: it's a cheap
// no-op when there's nothing to reclaim, and deletions can happen
// (GDPR erasure) even when RETENTION_DAYS is unset.
const runIncrementalVacuum = () => {
  try {
    db.pragma("incremental_vacuum(1000)");
  } catch (error) {
    logError("Incremental vacuum failed", error);
  }
};
runIncrementalVacuum();
setInterval(runIncrementalVacuum, 24 * 60 * 60 * 1000);

// On by default (LOCAL_BACKUPS=false to opt out) — a hot backup (safe
// to run against a live database, see lib/backup.ts) is written once
// at startup and then once a day, keeping the last 7 days' worth, into
// a "backups" folder next to the database file itself — so it's on the
// same persistent volume automatically, without a separate directory
// to configure. This is a local safety net against mistakes (bad
// migration, accidental deletion) — it does not protect against losing
// the whole volume/disk, which still needs an off-host copy (see
// README's "Data lifecycle" section).
if (config.localBackups) {
  const backupDir = join(config.dataDir, "backups");
  const runBackupJob = () => {
    runBackup(db, backupDir, eventsPath, contextPath).catch(
      (error: unknown) => {
        logError("Backup failed", error);
      },
    );
  };
  runBackupJob();
  setInterval(runBackupJob, 24 * 60 * 60 * 1000);
}

const server = app.listen(config.port, () => {
  logInfo("genug server listening", {
    version: VERSION,
    port: config.port,
    trustProxyHops: config.trustProxyHops,
  });
});

// On redeploy, Docker/Coolify sends SIGTERM before killing the
// container. Not needed for data safety — better-sqlite3's WAL mode is
// crash-safe even on a hard kill — but this lets in-flight requests
// finish and closes the db handle cleanly instead of just vanishing
// mid-response.
function shutdown(signal: string): void {
  logInfo("Shutting down", { signal });
  server.close(() => {
    // The counter lives in memory, so without this every redeploy
    // loses up to an hour of bot hits. After close, so in-flight
    // requests are counted too.
    runBotActivityFlush();
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
