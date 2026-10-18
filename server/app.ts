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

// Builds the HTTP server: every route, in the right order, from the
// settings and the open database. index.ts calls this once and starts
// listening; the background jobs (retention, backups, vacuum) are in
// index.ts.
//
// It starts one timer, for replacing the daily salt at midnight, because
// only /events uses the salt. The timer doesn't keep the process alive
// on its own (unref).
export function createApp({
  config,
  db,
}: {
  config: Config;
  db: Database.Database;
}): Express {
  // Build every MCP tool once now, so a tool that breaks a rule
  // (requireSegment and the annotation check in mcp/tools.ts) stops the
  // server at startup, not at the first /mcp request.
  getToolManifest(db, { readOnly: config.readOnly, timezone: config.timezone });

  const app = express();
  app.disable("x-powered-by");

  // Trust as many proxies as TRUST_PROXY says (1 for one reverse proxy
  // such as Coolify's Traefik, 2 with Cloudflare in front as well). Unset
  // means no proxy, and X-Forwarded-For is ignored.
  app.set("trust proxy", config.trustProxyHops);

  app.use(baseSecurityHeaders);

  // Lets Coolify/Docker check that the server can really answer: it
  // queries the database, not just that the process runs.
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
      siteHosts: config.siteHosts,
      dailySalt,
      diskGuard: createDiskGuard(config.dataDir),
      // Loaded at startup, so a missing or broken table stops the server
      // instead of storing "ZZ" for every visitor.
      countries: config.countryLookup
        ? loadCountryTable(config.countryDataDir)
        : undefined,
    }),
  );

  // /mcp has its own rate limit, checked together with the key (see
  // routes/mcp.ts).
  app.use(
    "/mcp",
    createMcpRouter({
      db,
      mcpApiKey: config.mcpApiKey,
      readOnly: config.readOnly,
      timezone: config.timezone,
      siteHosts: config.siteHosts,
    }),
  );

  mountClientScript(app);
  mountCockpit(app, config, db);
  return app;
}

// The client script finds /events from its own URL
// (document.currentScript, see packages/client), so it must be served
// from this server. It is called "client.js", not "tracker.js", because
// ad-blocker lists block common tracker file names.
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

// Cache client.js for an hour. Every request gets the same bytes, so
// caching is safe. An old cached copy does no harm (see
// lib/clientScript.ts): the client sends a role, never a name, for the
// events it fires itself, so an old copy can't cause rejected events.
//
// Not a day, as hosted trackers use. The URL can't change with each
// version, because it is written in the site's own HTML. So the cache
// time is also how long a fix takes to reach every visitor, and an hour
// is a wait someone can sit out.
const CLIENT_CACHE_SECONDS = 3600;

// The cockpit: its JSON routes and the static page from /apps/cockpit,
// on the same origin, so no CORS is needed. COCKPIT_PASSWORD is required
// (loadConfig fails without it), because the cockpit shows recent URLs
// and props.
//
// The order matters. Headers first, so even the sign-in page and a 401
// have the CSP, together with the rate limit, which counts every
// request, signed in or not. Then the sign-in and sign-out routes, which
// must work without a session. Then the session check, in front of the
// JSON routes and the static files.
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
      siteHosts: config.siteHosts,
      cockpitPassword: config.cockpitPassword,
      retentionDays: config.retentionDays,
    }),
  );

  // The two pages are served with versioned script and stylesheet URLs
  // (lib/cockpitPage.ts), so a CDN with old scripts can't combine them
  // with a new page. Rendered once here so a missing file stops startup,
  // then on every request so an edit shows on reload.
  //
  // `private, no-cache`: the page must always be fetched fresh and never
  // be stored by a shared cache. Cloudflare doesn't cache HTML by
  // default, but this header makes sure.
  const cockpitDir = fileURLToPath(
    new URL("../../apps/cockpit", import.meta.url),
  );
  renderCockpitPage(cockpitDir, "index.html");
  renderCockpitPage(cockpitDir, "login.html");
  const cockpitPages = express.Router({ strict: true, caseSensitive: true });
  function sendCockpitPage(page: CockpitPage) {
    return (req: express.Request, res: express.Response, next: () => void) => {
      // "/cockpit" without a trailing slash also arrives here as "/".
      // Let express.static redirect it to "/cockpit/", or the page's
      // relative URLs would point at the site root.
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
      // Everything here needs a session, so no shared cache may keep a
      // copy: `public` would let a CDN store cockpit.js.
      setHeaders: (res) => res.setHeader("Cache-Control", "private, no-cache"),
    }),
  );
}
