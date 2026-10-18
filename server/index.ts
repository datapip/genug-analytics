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

// The server's entry point. It reads the settings first, so a missing or
// invalid one stops the server before anything is opened.
const config = loadConfig();
const db = openDatabase(config.dbPath);
const app = createApp({ config, db });

// Logged at startup, so the owner can check in the log that read-only
// mode (for a public MCP key) is really on.
if (config.readOnly) {
  logInfo(
    "READ_ONLY is set — the writing tools (delete_visitor_data, add_history_note) and get_recent_events are not registered, and the cockpit refuses every edit, reload and reset. Collection on /events continues.",
  );
}

// Logged for the same reason: it changes what every row stores, and the
// privacy notice must mention it (docs/privacy.md).
if (config.countryLookup) {
  logInfo(
    "COUNTRY_LOOKUP is on — each event stores the country of the shortened address, looked up on this server.",
  );
  // With no proxy trusted, every request seems to come from the proxy's
  // address, so every visitor would get the proxy's country.
  if (config.trustProxyHops === 0) {
    logInfo(
      "COUNTRY_LOOKUP is on with TRUST_PROXY=0. If a reverse proxy sits in front of this server, every visitor gets the proxy’s country: set TRUST_PROXY to the number of proxies.",
    );
  }
}

const keyWarning = shortMcpApiKeyWarning(config.mcpApiKey, config.readOnly);
if (keyWarning) logInfo(keyWarning);

// Logged at startup, like READ_ONLY above. "*" is allowed, but it means
// a newsletter's ?email= or a reset link's token is stored, shown in the
// cockpit and read by the agent.
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

// Creates the ground-rules and history files on the volume the first
// time, and never touches them again. A failure doesn't stop the server:
// the agent gets the built-in text with a note saying so.
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

// Deletes old events at startup and then once a day. A setInterval is
// enough, since the server runs continuously.
const { retentionDays } = config;
if (config.retentionDaysIsDefault) {
  // Log the default, because it decides how much data the job below
  // deletes, and the owner should see that before it runs. See "Data
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

// Saves the bot counter (routes/events.ts) as one row per hour, and only
// when there were bot requests, so a quiet site adds no rows. Not at
// startup, since the counter is still zero then.
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

// Off with UPDATE_CHECK=false. Failures are not logged (see
// lib/updateCheck.ts).
if (config.updateCheck) {
  startUpdateCheck(VERSION);
}

// Gives back disk space from deleted rows (retention above, or
// delete_visitor_data) a little at a time (see db/migrations.ts). Always
// runs: it costs nothing when there is nothing to do, and rows can be
// deleted even when events are kept forever.
const runIncrementalVacuum = () => {
  try {
    db.pragma("incremental_vacuum(1000)");
  } catch (error) {
    logError("Incremental vacuum failed", error);
  }
};
runIncrementalVacuum();
setInterval(runIncrementalVacuum, 24 * 60 * 60 * 1000);

// Backups, on unless LOCAL_BACKUPS=false: a copy at startup and then
// once a day, keeping 7 days, in a "backups" folder next to the database
// (so on the same volume). They protect against mistakes like accidental
// deletion, not against losing the volume; that needs a copy on another
// machine (see "Data lifecycle" in the README).
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

// On redeploy, Docker/Coolify sends SIGTERM before stopping the
// container. The data would be safe anyway (WAL mode survives a crash),
// but this lets running requests finish and closes the database
// properly.
function shutdown(signal: string): void {
  logInfo("Shutting down", { signal });
  server.close(() => {
    // Save the bot counter, or a redeploy would lose up to an hour of
    // it. After close, so the last requests are counted too.
    runBotActivityFlush();
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
