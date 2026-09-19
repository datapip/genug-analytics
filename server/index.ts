import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import express from "express";
import { eventsPath } from "@genug/schema-registry";
import { db, dbPath } from "./db/index.js";
import { eventsRouter } from "./routes/events.js";
import { mcpRouter } from "./routes/mcp.js";
import { cockpitRouter } from "./routes/cockpit.js";
import { createCockpitAuth } from "./lib/cockpitAuth.js";
import {
  parseRetentionDays,
  pruneOldEvents,
  pruneOldRejectedEvents,
  pruneOldBotActivity,
} from "./lib/retention.js";
import { runBackup, parseLocalBackupsEnabled } from "./lib/backup.js";
import {
  parsePort,
  parseReadOnly,
  parseTrustProxy,
  requireEnv,
} from "./lib/env.js";
import { VERSION } from "./lib/version.js";
import {
  baseSecurityHeaders,
  cockpitSecurityHeaders,
} from "./lib/securityHeaders.js";
import { rateLimitEvents } from "./lib/rateLimit.js";
import { drainBotHits, botActivityCounter } from "./lib/botActivity.js";
import { insertBotActivity } from "./db/botActivity.js";
import { logInfo, logError } from "./lib/logger.js";
import { seedContextFiles, contextPath } from "./lib/context.js";

const app = express();
app.disable("x-powered-by");

// Trust only as many proxy hops as TRUST_PROXY says are in front of us
// (1 for a single reverse proxy like Coolify's Traefik, 2 behind
// Cloudflare as well). Unset means the port is published directly and
// X-Forwarded-For is believed from nobody.
const trustProxyHops = parseTrustProxy(process.env.TRUST_PROXY);
app.set("trust proxy", trustProxyHops);

app.use(baseSecurityHeaders);

// Lets Coolify/Docker tell "container started" from "actually able to
// serve requests" — checks the database is reachable, not just that the
// process is alive.
app.get("/healthz", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.sendStatus(200);
  } catch {
    res.sendStatus(500);
  }
});

app.use("/events", rateLimitEvents, eventsRouter);
// /mcp mounts its own request limiter, ahead of its key check (see
// routes/mcp.ts).
app.use("/mcp", mcpRouter);

// Said once at startup, like the retention line below: a read-only
// deployment is one whose MCP key is meant to be public, and the log
// is where an operator checks that the mode they configured is the
// mode that is running. A bad value has already thrown by now — the
// routers imported above parse it at module scope — so this call only
// ever decides whether to log.
if (parseReadOnly(process.env.READ_ONLY)) {
  logInfo(
    "READ_ONLY is set — the writing tools (delete_visitor_data, add_history_note) are not registered and the cockpit refuses every edit, reload and reset. Collection on /events continues.",
  );
}

// The client script's endpoint auto-detection (see packages/client) relies
// on this file being served from this same origin — document.currentScript's
// own URL is how it finds /events, no separate config needed.
// Named "client.js", not "tracker.js" — ad-blocker filter lists
// (EasyList/EasyPrivacy) block well-known generic tracker filenames.
const clientJs = readFileSync(
  fileURLToPath(
    new URL("../../packages/client/dist/index.js", import.meta.url),
  ),
);

// An hour. This file is now pure code — byte-identical for every
// deployment — which is what makes caching it hard safe again.
//
// It was cut to five minutes when the script carried a preamble of this
// deployment's event names: a cached copy kept firing the names current
// when it was fetched, so the cache window was also the window in which
// renaming an event produced rejected events. The client sends a role
// instead of a name now (see routes/events.ts), so there is nothing
// deployment-specific left in here to go stale.
//
// Not a day, which is what the hosted trackers use. The filename can't
// be versioned to escape the window — the URL lives in the tracked
// site's own HTML, a separate deploy this server doesn't control, which
// is the whole point of the script detecting its endpoint from its own
// src — so the window is also how long a fix to this file takes to
// reach every visitor. An hour trades almost all of the request saving
// for a recovery time someone can actually wait out.
const CLIENT_CACHE_SECONDS = 3600;

app.get("/client.js", (req, res) => {
  res.set("Cache-Control", `public, max-age=${CLIENT_CACHE_SECONDS}`);
  res.type("application/javascript").send(clientJs);
});

// Cockpit: JSON data route + the static preview page, same origin —
// no CORS needed, unlike the client script. Byte-serving only; the
// actual HTML/CSS/JS is authored entirely in /apps/cockpit, not /server.
//
// COCKPIT_PASSWORD is required (requireEnv, so startup fails without
// it). The cockpit serves recent event URLs and raw props, at an
// entirely predictable hostname — for a self-hosted privacy tool, this
// is the one setting that must not have an insecure default.
//
// Three layers, and the order is the point. Headers first, so even the
// login page and a 401 carry the CSP. Then the sign-in and sign-out
// routes, which have to be reachable without a session by definition.
// Then the gate, which everything below it — the JSON router and the
// static files alike — sits behind.
const cockpitAuth = createCockpitAuth(requireEnv("COCKPIT_PASSWORD"));
app.use("/cockpit", cockpitSecurityHeaders, cockpitAuth.router);
app.use("/cockpit", cockpitAuth.requireSession);
app.use("/cockpit", cockpitRouter);
app.use(
  "/cockpit",
  express.static(fileURLToPath(new URL("../../apps/cockpit", import.meta.url))),
);

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

// Optional: if set, old events are pruned once at startup and then once
// a day — a plain setInterval is enough since this is already a single
// long-running process, no external cron needed.
const retentionDays = parseRetentionDays(process.env.RETENTION_DAYS);
if (process.env.RETENTION_DAYS === undefined) {
  // Unset now defaults to DEFAULT_RETENTION_DAYS instead of forever
  // (see "Data lifecycle" in docs/decisions.md for why, and why this
  // stays loud rather than becoming quiet just because the default
  // changed to a reasonable one): a deployment upgrading from a version
  // where unset meant forever needs to see this before the prune below
  // runs, not discover it after. `RETENTION_DAYS=-1` is the explicit
  // way to say "forever, on purpose" now that omitting it no longer
  // does.
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
if (parseLocalBackupsEnabled(process.env.LOCAL_BACKUPS)) {
  const backupDir = join(dirname(dbPath), "backups");
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

const port = parsePort(process.env.PORT);

const server = app.listen(port, () => {
  logInfo("genug server listening", { version: VERSION, port, trustProxyHops });
});

// On redeploy, Docker/Coolify sends SIGTERM before killing the
// container. Not needed for data safety — better-sqlite3's WAL mode is
// crash-safe even on a hard kill — but this lets in-flight requests
// finish and closes the db handle cleanly instead of just vanishing
// mid-response.
function shutdown(signal: string): void {
  logInfo("Shutting down", { signal });
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
