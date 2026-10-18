import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import express, { type Express } from "express";
import type Database from "better-sqlite3";
import type { Config } from "./lib/config.js";
import { createEventsRouter } from "./routes/events.js";
import { createMcpRouter } from "./routes/mcp.js";
import { createCockpitRouter } from "./routes/cockpit.js";
import { createCockpitAuth } from "./lib/cockpitAuth.js";
import {
  SESSION_SALT_FILE,
  loadSessionSalt,
} from "./lib/cockpitSessionSalt.js";
import { renderCockpitPage, type CockpitPage } from "./lib/cockpitPage.js";
import {
  baseSecurityHeaders,
  cockpitSecurityHeaders,
} from "./lib/securityHeaders.js";
import { rateLimitCockpit, rateLimitEvents } from "./lib/rateLimit.js";
import { createDailySalt, startRotation } from "./lib/dailySalt.js";
import { loadCountryTable } from "./lib/country.js";
import { createDiskGuard } from "./lib/diskSpace.js";
import { getToolManifest } from "./mcp/tools.js";
import { renderClientScript } from "./lib/clientScript.js";

// The whole HTTP side of the server: every route, in the order that
// matters, built from the settings and the open database it is handed.
// index.ts calls this once and listens; the background jobs (retention,
// backups, vacuum) are index.ts's, since they are not part of answering
// a request.
//
// It does start one timer, the daily salt's rotation, because the
// salt belongs to /events and nothing else. The timer is unref'd, so it
// never keeps a process alive on its own.
export function createApp({
  config,
  db,
}: {
  config: Config;
  db: Database.Database;
}): Express {
  // Builds every MCP tool once, now, so a tool that breaks a rule
  // (requireSegment and the annotation check in mcp/tools.ts) stops the
  // server at startup instead of failing the first /mcp request.
  getToolManifest(db, { readOnly: config.readOnly, timezone: config.timezone });

  const app = express();
  app.disable("x-powered-by");

  // Trust only as many proxy hops as TRUST_PROXY says are in front of us
  // (1 for a single reverse proxy like Coolify's Traefik, 2 behind
  // Cloudflare as well). Unset means the port is published directly and
  // X-Forwarded-For is believed from nobody.
  app.set("trust proxy", config.trustProxyHops);

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

  const dailySalt = createDailySalt(
    join(config.dataDir, "daily-salt.json"),
    config.timezone,
  );
  startRotation(dailySalt);
  app.use(
    "/events",
    rateLimitEvents,
    createEventsRouter({
      db,
      allowedOrigins: config.allowedOrigins,
      dailySalt,
      diskGuard: createDiskGuard(config.dataDir),
      // Loaded here, so a missing or broken table stops the start
      // rather than storing "ZZ" for every visitor.
      countries: config.countryLookup
        ? loadCountryTable(config.countryDataDir)
        : undefined,
    }),
  );

  // /mcp mounts its own request limiter, ahead of its key check (see
  // routes/mcp.ts).
  app.use(
    "/mcp",
    createMcpRouter({
      db,
      mcpApiKey: config.mcpApiKey,
      readOnly: config.readOnly,
      timezone: config.timezone,
    }),
  );

  mountClientScript(app);
  mountCockpit(app, config, db);
  return app;
}

// The client script's endpoint auto-detection (see packages/client) relies
// on this file being served from this same origin — document.currentScript's
// own URL is how it finds /events, no separate config needed.
// Named "client.js", not "tracker.js" — ad-blocker filter lists
// (EasyList/EasyPrivacy) block well-known generic tracker filenames.
function mountClientScript(app: Express): void {
  const clientJs = renderClientScript(
    readFileSync(
      fileURLToPath(
        new URL("../../packages/client/dist/index.js", import.meta.url),
      ),
      "utf8",
    ),
  );
  app.get("/client.js", (req, res) => {
    res.set("Cache-Control", `public, max-age=${CLIENT_CACHE_SECONDS}`);
    res.type("application/javascript").send(clientJs);
  });
}

// An hour. This file is pure code plus the kept-parameter lists, written
// in once at startup — the same bytes for every request — which is what
// makes caching it safe. The lists can go stale in a cached copy
// harmlessly; see lib/clientScript.ts for why. Nothing else in it can:
// the client sends a role, never a name, for the events it fires itself
// (routes/events.ts), so a stale copy cannot produce rejected events.
//
// Not a day, which is what the hosted trackers use. The filename can't
// be versioned to escape the window — the URL lives in the tracked
// site's own HTML, a separate deploy this server doesn't control, which
// is the whole point of the script detecting its endpoint from its own
// src — so the window is also how long a fix to this file takes to
// reach every visitor. An hour trades almost all of the request saving
// for a recovery time someone can actually wait out.
const CLIENT_CACHE_SECONDS = 3600;

// Cockpit: JSON data route + the static preview page, same origin —
// no CORS needed, unlike the client script. Byte-serving only; the
// actual HTML/CSS/JS is authored entirely in /apps/cockpit, not /server.
//
// COCKPIT_PASSWORD is required (loadConfig fails without it). The
// cockpit serves recent event URLs and raw props, at an entirely
// predictable hostname — for a self-hosted privacy tool, this is the one
// setting that must not have an insecure default.
//
// Three layers, and the order is the point. Headers first, so even the
// login page and a 401 carry the CSP. The request limiter beside them
// counts every request, signed in or not. Then the sign-in and sign-out
// routes, which have to be reachable without a session by definition.
// Then the gate, which everything below it — the JSON router and the
// static files alike — sits behind.
function mountCockpit(
  app: Express,
  config: Config,
  db: Database.Database,
): void {
  const cockpitAuth = createCockpitAuth(
    config.cockpitPassword,
    loadSessionSalt(join(config.dataDir, SESSION_SALT_FILE)),
  );
  app.use(
    "/cockpit",
    cockpitSecurityHeaders,
    rateLimitCockpit,
    cockpitAuth.router,
  );
  app.use("/cockpit", cockpitAuth.requireSession);
  app.use(
    "/cockpit",
    createCockpitRouter({
      db,
      readOnly: config.readOnly,
      timezone: config.timezone,
      cockpitPassword: config.cockpitPassword,
      retentionDays: config.retentionDays,
    }),
  );

  // The two pages go out with every script and stylesheet address
  // versioned (lib/cockpitPage.ts), so a CDN keeping old scripts can't
  // pair them with a new page. Rendered once here so a missing file stops
  // startup, then again per request so an edit shows on reload.
  //
  // `private, no-cache` is what the fix rests on: the page must always be
  // fetched fresh, and never stored by a shared cache. Today Cloudflare
  // happens to leave HTML alone; this says so rather than relying on it.
  const cockpitDir = fileURLToPath(
    new URL("../../apps/cockpit", import.meta.url),
  );
  renderCockpitPage(cockpitDir, "index.html");
  renderCockpitPage(cockpitDir, "login.html");
  const cockpitPages = express.Router({ strict: true, caseSensitive: true });
  function sendCockpitPage(page: CockpitPage) {
    return (req: express.Request, res: express.Response, next: () => void) => {
      // "/cockpit" with no slash arrives here as "/" too. Leave it to
      // express.static's redirect, or the page's relative addresses would
      // resolve against the site root.
      if (req.path === "/" && !req.originalUrl.split("?")[0]!.endsWith("/")) {
        next();
        return;
      }
      res
        .set("Cache-Control", "private, no-cache")
        .type("html")
        .send(renderCockpitPage(cockpitDir, page));
    };
  }
  cockpitPages.get(["/", "/index.html"], sendCockpitPage("index.html"));
  cockpitPages.get("/login.html", sendCockpitPage("login.html"));
  app.use("/cockpit", cockpitPages);
  app.use(
    "/cockpit",
    express.static(cockpitDir, {
      // Everything here is past the session gate, so no shared cache may
      // keep a copy: `public` would let a CDN store cockpit.js at its edge.
      setHeaders: (res) => res.setHeader("Cache-Control", "private, no-cache"),
    }),
  );
}
