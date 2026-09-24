# Design decisions

The full architecture and design journal for Genug Analytics — what was
decided, and *why*, including the options that were rejected and the
mistakes that were fixed. It is a record, not a set of instructions.

**Read this when you need to know why something is the way it is** —
before proposing an architectural change, or when a rule in `AGENTS.md`
looks arbitrary and you want the reasoning behind it. For *doing* a
normal task (adding an event, an MCP tool, or changing the cockpit),
`AGENTS.md` and the recipes in `docs/` are the short path; you do not
need to read this file first.


## Current status

**Not live anywhere yet.** No real deployment, no real client, no real
collected data. This means breaking changes — renaming a field, changing
the envelope, altering a stored schema — are cheap right now: there's no
production database to migrate and no external consumer (a client's AI
agent config, a cockpit bookmark) to keep working. Prefer the cleanest
name/shape over a backwards-compatible one while this holds. Remove this
note once a real deployment exists — from that point on, breaking
changes need actual migration/compatibility thinking, same as any other
production system.

## What this is

A self-hosted, lightweight web analytics pipeline for small/moderate-traffic
companies that have no dedicated analyst. Instead of a dashboard, the end
user connects an AI agent (via MCP) and asks questions in natural language.

Explicitly NOT trying to be Matomo/PostHog/GA4. No complex UI, no advanced
segmentation builder, no enterprise features. Simple, solid, easy to deploy
by one dev, easy to reason about for the AI.

## Target user

A small company or freelancer's client with moderate traffic, no analytics
team. Someone (a dev, not an analyst) installs it once, adds a script tag,
and from then on interacts with their data purely by asking their AI agent
questions. Setup should be "add script + point env var" simple.

## Core design principle

Flexible event schema (open JSON payload, not locked to a GA4/PostHog
data model) + a schema registry file that tells the AI what each event
and property means. The registry is what makes the flexibility usable —
without it, custom events are just unlabeled noise to the agent.

## Repo structure

Monorepo, npm workspaces. Deliberately collapsed to ONE server process —
collector, metrics, and MCP server are modules within it, not separate
services. They share the same SQLite connection in-process; no network
hop between them, no separate deploys, one port.

```
/packages
  /client           - mini JS snippet, sends events to the server
  /schema-registry  - shared Zod schemas for envelope + event definitions
/server              - the one app: Express + MCP, single process
  index.ts           - starts Express, mounts routes + MCP transport,
                       serves the built client script at /client.js
                       and /apps/cockpit's static files at /cockpit
  routes/events.ts   - POST /events ("collector" logic)
  routes/mcp.ts      - Express/transport wiring for MCP: API key check,
                       stateless StreamableHTTPServerTransport per request
  lib/               - the query layer, one module per kind of question:
                       traffic.ts (how much, when), content.ts (pages,
                       referrers), events.ts (event types, props),
                       audience.ts (devices, locales, consent),
                       recentEvents.ts, plus funnel/segment/
                       rejectedEvents/botActivity. Plain functions over
                       the db; period.ts holds the shared Period type,
                       aggregate.ts the two shaping helpers used by more
                       than one of them
  mcp/               - MCP tools, grouped by the kind of question they
                       answer; call the lib/ query modules directly. tools.ts is
                       just the wiring (createMcpServer + the manifest
                       wrapper), shared.ts the common input schemas and
                       result helpers, and registry/traffic/content/
                       events/audience/diagnostics/admin the tools
  db/                - SQLite connection + raw SQL queries
  routes/cockpit.ts  - small read-only JSON route for the cockpit below
  integration/       - tests that spawn the compiled dist/index.js as a
                       real subprocess, for the startup/shutdown wiring
                       index.ts does that has no function to unit-test
/apps
  /cockpit           - static page, no framework/build step: previews
                       collected data + the schema registry, via
                       routes/cockpit.ts. index.html + cockpit.css +
                       cockpit.js + theme.js, served as-is
```

Shared TypeScript types/Zod schemas live in `schema-registry` and are
imported by both `client` (for typed event sending, optional) and
`/server` — single source of truth, no duplicated event definitions.

### One set of docs, split by task rather than by reader

Proposed: separate documentation for humans and for AI agents, so each
could suit its reader — pictures and plain language for one, everything
useful for the other. Rejected, because the split already exists along
the line that matters. `AGENTS.md` is the contract every agent loads,
kept short because it costs context every session; `decisions.md` is
the long form, read on demand. `README.md` and the recipes are written
for an operator, and an agent is only routed there for the task that
needs them. The premise that an AI document can carry everything is
the opposite of this repo's rule: the agent side already has its
short/long split, and a longer contract is what that rule exists to
prevent.

Where the two readers overlap — the privacy section of the README and
the three recipes — a second copy is exactly where drift would start,
on the facts (envelope fields, consent semantics, salt and truncation)
that already live in three places. Nor are the file names changed:
`README.md` is what GitHub renders and `AGENTS.md` is the cross-tool
convention every coding agent looks for, so a `.user.md` / `.ai.md`
suffix would cost both without telling a reader anything the routing
table at the top of `AGENTS.md` does not.

The real problem was narrower: a 1,200-line README is a lot for a
human's first ten minutes. `docs/getting-started.md` is the fix — the
screenshot and five steps, each one paragraph linking into the README
heading that has the detail. It holds no facts of its own, so there is
nothing in it to drift.

## Tech stack (decided)

- **Language:** TypeScript everywhere (strict mode).
- **Monorepo tooling:** npm workspaces (native since npm v7, bundled
  with Node — nothing extra to install). Originally pnpm, switched once
  it became clear pnpm's actual advantages here (a stricter
  `node_modules`, a disk-space-saving shared store) weren't worth the
  cost of a second tool a contributor has to learn on top of Node/npm,
  which everyone already has — npm workspaces cover the one thing this
  project actually needs (multiple local packages that reference each
  other) just as well. This also removes `corepack` and its
  `packageManager` pin from the picture entirely — npm ships with Node,
  so there's no separate version-pinning step needed. (Turborepo only
  if build times become a problem — don't add it preemptively.)
- **Server:** Express, one standalone Node process serving both the
  `/events` collector route and the MCP endpoint. Not Next.js — no UI
  planned, and a lean ingestion service should stay lean. Chosen over
  Hono/Fastify for being the most established, most basic option with
  the largest community.
- **SQLite driver:** `better-sqlite3` — synchronous, simple API, long-
  established. Not Node's built-in `node:sqlite`, which is still flagged
  experimental as of writing.
- **DB access:** Raw SQL via `better-sqlite3`, no ORM. Removed Drizzle —
  for a handful of simple queries (insert event, session aggregates, top
  pages) a query builder/ORM layer added abstraction without real
  benefit, and hand-written SQL is more transparent for learning
  purposes. Zod (via schema-registry) already provides the type-safety
  an ORM would otherwise give.
- **Test framework:** `node:test` (Node's built-in test runner) +
  `node:assert` — zero added dependency. Considered Vitest, but for this
  project's needs (straightforward unit tests, no need for snapshot
  testing or heavy mocking) the built-in runner covers it, so it wins on
  the dependency philosophy's "prefer the standard library when it
  reasonably covers the need" rule.
- **Database:** SQLite. Single file, zero ops, fits moderate traffic.
  Only reconsider (Postgres) if a specific deployment's volume demands it
  — don't build for a scale we don't have yet.
- **Validation:** Zod, shared between the events route (validate incoming
  events) and schema-registry (define what's valid).
- **MCP server:** official `@modelcontextprotocol/sdk` (TypeScript),
  mounted inside the same Express process via the streamable HTTP
  transport (e.g. a `/mcp` route) — not a separate local stdio process.
  This means the end user points their AI client at one URL; nothing to
  install or keep running locally per client.

- **Cockpit UI:** a minimal static HTML/JS page in `/apps/cockpit` —
  no framework — fetching from one small new read-only JSON route added
  to `/server` (`routes/cockpit.ts`), which reuses the `lib/` query
  modules and
  the schema registry directly. Chosen over a separate Next.js app (the
  earlier tentative idea) for zero new dependencies and one process, not
  two — the actual v1 ask is a simple read-only preview, not an app.
  Revisit this specific choice only if/when admin (write) functionality
  is concretely scoped — a form-heavy CRUD surface is a different job
  than a preview page, not something to design for now.

  **Split into four files, still with no build step.**
  `index.html` had grown to ~1850 lines holding markup, all the CSS and
  all the JS, and had become the largest file in the repo. It's now
  `index.html` (markup, ~290 lines) + `cockpit.css` + `cockpit.js` +
  `theme.js`, all served straight from the same static folder, so the
  "no bundler, no build step, just edit the file" property that made a
  single file attractive is completely intact — there was never a
  technical reason for them to be one file, only inertia.

  Three things fell out of the split beyond readability:
  - **The JS is now linted.** While it lived inside `<script>` tags in
    an HTML file, eslint never saw it; as a real `.js` file it does.
    That needed the browser globals it uses (`document`, `window`,
    `localStorage`, `fetch`, `Node`, `ResizeObserver`) declared in
    `eslint.config.js` — listed by hand rather than adding the
    `globals` package, which would be a dependency for one config line.
    Anything new the cockpit reaches for now shows up as a lint error
    rather than slipping in unnoticed.
  - **The CSP could drop `'unsafe-inline'` from `script-src`** (see
    "Security headers" below), because the page now has no inline
    script at all.
  - **`theme.js` stays a blocking `<script>` in `<head>`**, not
    deferred and not merged into `cockpit.js`. It has to set the theme
    attribute before the first paint or the page flashes the wrong
    theme on load; being same-origin and tiny, the extra request costs
    nothing meaningful. Verified after the split that a saved dark
    preference is applied at first paint, not after.

  **"Cockpit" is the name everywhere, not just in the UI.** The page
  had been retitled Cockpit while every identifier around it still said
  dashboard — the route (`/dashboard`), the folder
  (`apps/dashboard`), `routes/dashboard.ts`, `lib/dashboardAuth.ts`,
  and `DASHBOARD_PASSWORD`. That split meant the thing was called two
  different names depending on whether you were reading the screen or
  the code. Renamed wholesale to `/cockpit`, `apps/cockpit`,
  `routes/cockpit.ts`, `lib/cockpitAuth.ts` and `COCKPIT_PASSWORD`.
  Both the URL and the env var are breaking changes, which is exactly
  the kind of rename "Current status" at the top of this file says is
  free while no real deployment exists — revisit that reasoning before
  doing anything like this again once one does. Note that "dashboard"
  survives deliberately in a handful of places where it means the
  *category* rather than this feature ("instead of a dashboard, the end
  user connects an AI agent") — that contrast is the product pitch, and
  renaming it would have destroyed the sentence's meaning.

  **Redesigned and renamed "Cockpit".** The original page only ever
  showed sessions/events/rejected counts, a 7-day trend, top pages,
  recent events, and the schema registry — a lot of what's actually
  computed server-side (referrers, device breakdown, bot activity, the
  day-of-week/hour tools) had no visual presence at all. Deliberately
  *not* redesigned into a full analytics-exploration tool though — this
  project still isn't trying to be Matomo/GA4 (see "What this is"); the
  cockpit's job stays "a quick glance," with follow-up questions
  delegated to the AI agent. Concretely, that meant adding only metrics
  that answer "is this healthy" or "what's the traffic shape" at a
  glance (referrers, device breakdown, bot activity, a trend
  granularity toggle), while deliberately leaving out ones that need a
  follow-up question to interpret (funnels, segments, property sums,
  entry/exit/bounce pages, new-vs-returning) — those stay agent-only.
  - **A period picker** (24h/7d/30d, `routes/cockpit.ts`'s
    `?days=` query param) — previously hardcoded to a 7-day window with
    no way to change it, a real gap for something calling itself a
    cockpit. Only three fixed options, not a free-form date range — a
    custom range is analysis, which is the agent's job.
  - **A trend granularity toggle** (Daily / By weekday / By hour) on the
    existing chart, backed by `getTrafficByDay`/`getTrafficByDayOfWeek`/
    `getTrafficByHour` (see "Core product value" below) — these three
    functions already existed as MCP tools with zero cockpit presence
    before this. Daily renders as a line chart (a genuine time series);
    weekday/hour render as paired bars (discrete categories, no
    meaningful slope between them). All three share one additive
    `interactionEvents`/`viewEvents` shape. An older `getDailyTraffic`
    with a flat `events` field used to back this chart and was kept
    around afterwards "in case something needs it" — nothing ever did,
    so it has since been deleted rather than left as dead code whose
    comment still claimed a consumer it no longer had.
  - **Top referrers and a device/browser breakdown**, alongside the
    existing top pages table — "where's my traffic coming from" and
    "what are people using" are two of the most basic questions any
    analytics tool answers, and neither had a cockpit widget before.
  - **A fourth stat card, bots filtered** (`getBotActivityCount`) —
    bot-drop counts existed server-side with no UI visibility at all.
  - **A consent share line under the stat strip**
    (`getConsentBreakdown`) — same gap as the bot counts above:
    `consent_mode` is stored on every row and the MCP tool already
    reported it, while the page showed nothing. It belongs here on the
    "is this healthy" side rather than the agent-only side, because a
    site that wires up a consent banner and breaks it has no other
    visible symptom — everything just silently stays consentless.

    A line rather than a fifth stat card: consent tooling is out of v1
    scope (see "Explicitly out of scope"), so plenty of deployments
    have no banner at all and a card would read 100% consentless
    forever. Counted in events, not sessions — a visitor who accepts
    mid-visit keeps the same `session_id` (see "Visitor
    identification"), so a session has no single consent mode to
    report. The raw counts sit alongside the percentage for the same
    reason `getBouncePages` returns them, and the line hides entirely
    for a period with no events, where a 0% share would read as a
    consent problem rather than an empty week.
  - **Recent events, moved directly under the health strip** (was
    previously near the bottom) — "is data actually flowing in right
    now" is arguably the single most cockpit-y question there is.
  - **An MCP tools overview**, next to the schema registry — see
    `mcp/tools.ts`'s `getToolManifest` below for how the list is derived
    rather than hand-maintained, so a deployment's own custom tools show
    up automatically.
  - **The schema registry table gained Type/Required columns**,
    surfacing the metadata `defineEvent` started producing once this
    reached the schema-registry MCP resource (see "Schema registry"
    above) — the cockpit previously only showed description/example.

  **Restyled afterwards, content unchanged.** The Cockpit rework above
  fixed *what* the page showed; this pass fixed how it looked, with no
  change to `routes/cockpit.ts` or to which numbers appear. The
  previous design was kept alongside it briefly as a visual reference
  and then deleted once the new one had settled — git history is the
  reference from here on.

  - **Grouped into two areas rather than one flat stack of sections.**
    Everything answering "what's happening right now" (stat strip,
    recent events, trend, the three breakdowns) sits above a labelled
    `Configuration` rule; the schema registry and MCP tool list sit
    below it inside `<details>` elements, collapsed by default. Those
    two are reference material read occasionally, but expanded they're
    several times taller than everything else combined — which left the
    actual health information a minority of the page. Native
    `<details>`/`<summary>`, not a JS accordion: keyboard- and
    screen-reader-accessible for free, and no state to manage.
  - **The four stat cards became one bordered strip split by hairlines.**
    They're read together as a single health line, and four separate
    floating boxes made them look like four unrelated widgets. The
    pastel icon tiles are gone: they assigned each number an arbitrary
    colour that implied a meaning it didn't have. Colour is now used
    only where it carries information — the rejected count turns red
    only once it's actually nonzero, so a glance shows whether anything
    needs attention.
  - **The trend chart gained a y-axis, gridlines and hover tooltips.**
    Previously it drew a shape with no readable magnitude at all. Axis
    maximums come from `niceMax`, which rounds the gap *between*
    gridlines (not the maximum itself) to a 1/2/5 × 10ⁿ value — rounding
    the maximum gives a tidy top number and ugly ones under it
    (0/13/26/39/52). It's also now drawn at the container's real pixel
    width via a `ResizeObserver` instead of a fixed viewBox stretched
    with `preserveAspectRatio="none"`, which was scaling the axis text
    and stroke widths horizontally and visibly distorting both.
  - **Top pages, top referrers and the device breakdown became one
    shared bar-list component**, each row carrying a proportional bar
    behind its label. Two of the three were bare count tables before, so
    comparing rows meant reading numbers rather than seeing lengths;
    they're also genuinely the same shape of answer, so they're now
    literally the same renderer rather than three near-copies.
  - **The wordmark is monochrome and inverted per theme** (`--logo-bg`/
    `--logo-ink`: black on white in light, white on black in dark)
    rather than a filled accent-coloured tile — same reasoning as the
    stat cards above, where colour that doesn't encode anything was
    removed rather than kept for decoration.
  - **No webfont.** A privacy-focused, self-hosted analytics tool
    shouldn't make its own cockpit fetch a font from a CDN, and
    self-hosting one would add weight for a page only the site owner
    ever opens — so `system-ui` throughout, same dependency-philosophy
    reasoning as the rest of the project.

## Deployment model

Self-hosted by the client, on a subdomain of their own site — e.g. the
tracked site is `client-domain.com`, the pipeline runs at
`analytics.client-domain.com`. This is not a shared SaaS the client signs
up for; they run their own instance.

This detail matters architecturally, not just operationally:

- **It resolves the cross-domain cookie problem.** `SameSite` and
  Safari's ITP classify cookies by registrable domain (eTLD+1), not exact
  host. Since the collector subdomain shares a registrable domain with
  the tracked site, a normal server-set cookie (`Set-Cookie`,
  `SameSite=Lax; Secure`, host-only, no explicit `Domain` attribute
  needed) is first-party from the browser's perspective — not blocked by
  ITP, no `SameSite=None` workaround, no localStorage fallback needed.
- **CORS can be strict, not permissive.** Since it's single-tenant, the
  collector's `/events` route only ever needs to accept requests from
  one known origin: the client's own domain, read from config. Do not
  default to a wildcard/reflect-any-origin CORS policy — set it to the
  configured domain explicitly.
- **Docker is the deployment mechanic** (was open, now decided). Each
  client's infrastructure will differ; a single Docker image with a
  handful of env vars is what makes "hand this to any client's server"
  actually simple, rather than assuming a specific OS/process manager.

## Configuration (env vars)

`.env.example` at the repo root is the copy-paste starting point, listing
every variable below, with an `openssl rand -hex 32` line on the
secret that should be generated rather than chosen (`MCP_API_KEY`;
`SALT_SECRET` was the second until the salt became random). It's committed deliberately (`.gitignore` ignores
`.env` and `.env.*` but re-includes this one) — eight variables, four of
which fail startup when missing, is more than a deployer should have to
reconstruct from prose.

- `PORT` — optional, defaults to `3000`. Validated by `lib/env.ts`'s
  `parsePort` (must be an integer between 1 and 65535) — fails fast at
  startup with a clear error rather than silently listening on `NaN`,
  same fail-fast spirit as `parseRetentionDays`.
- `DB_PATH` — optional, defaults to `/data/genug.db`. That default
  is deliberately a fixed path under `/data`, the exact directory the
  README/Docker/Coolify instructions already have the operator mount a
  persistent volume at — so most deployments never need to set this at
  all. Still overridable (e.g. local dev/testing outside Docker, see
  README.test.md), since it's just a filesystem path, not a secret.
- `ALLOWED_ORIGIN` — **required**. The client's own site domain, for
  CORS on `/events`. Read through `requireEnv` at module scope in
  `routes/events.ts`, so a missing value fails startup rather than
  quietly disabling CORS — same treatment as the three secrets below.
- `MCP_API_KEY` — **required**. Shared secret to call the MCP endpoint.
  The AI agent config on the client's side includes this key.
- `SALT_SECRET` — no longer read. It keyed the daily salt until the
  salt became random (see "The daily salt is random" under "Visitor
  identification").
- `COCKPIT_PASSWORD` — **required**. `/cockpit` (both the JSON route
  and the static page) is behind a sign-in page that exchanges this
  password for a session cookie (see "The cockpit signs in instead of
  re-sending a password"), and the server fails fast at startup without
  it, same as `MCP_API_KEY`.

  This was optional at first, defaulting to a fully open cockpit. That
  was wrong, and not a small wrongness: `/cockpit/data` returns recent
  events including full URLs and raw props — where order ids and other
  business data live — and the deployment model puts it at an entirely
  predictable public hostname. The target user is a small firm with few
  resources, exactly the deployment least likely to notice an optional
  variable and set it. For a project positioned on privacy, the one
  default that must not be the insecure one is this. Making it required
  is a breaking config change, taken under the "Current status" note at
  the top of this file while that's still free.
- `RETENTION_DAYS` — optional. If set, events older than this many days
  are deleted once at startup and then once a day (`lib/retention.ts`).
  If unset, events accumulate forever, same as before this existed.
- `LOCAL_BACKUPS` — optional, defaults to `true`. A hot backup of the
  database is written once at startup and then once a day, keeping the
  last 7 days (`lib/backup.ts`), into a `backups` folder next to
  `DB_PATH` itself — no separate directory to configure, since that
  folder ends up on the same persistent volume automatically. Uses
  `better-sqlite3`'s built-in `db.backup()` (SQLite's Online Backup
  API) — safe against a live, actively-written database, unlike a
  plain file copy under WAL mode. Set to `false` to opt out; any other
  value throws at startup rather than being silently misread.
- `READ_ONLY` — optional, defaults to `false`. Closes every write:
  `mcp/admin.ts` is not registered, so neither `delete_visitor_data` nor
  `add_history_note` exists, and the cockpit refuses every non-GET
  request. Exists for one deployment shape — the product
  page's demo instance, whose MCP key is printed on the page for anyone
  to use — and is parsed like `LOCAL_BACKUPS`, strictly,
  because a misspelt value that quietly meant "writes allowed" would be
  the one misconfiguration a public key cannot afford. See "Read-only
  mode" under "Operational safety" for what it does and does not close.

## Tenancy

Single-tenant. One deployed instance = one client/company. No
multi-tenant data isolation logic needed — do not add tenant_id
scaffolding, it adds complexity this project doesn't need.

## Data model

Fixed envelope + open payload. The client script sends event data;
identity fields are derived server-side, never trusted from the client:

```json
// Sent by the client script:
{
  "event": "product_added_to_cart",
  "consent": false,
  "url": "https://example.com/product/123",
  "referrer": "https://google.com/search?q=...",
  "props": { "product_id": "123", "value": 49.90, "currency": "EUR" }
}

// Stored row, after server processing:
{
  "event": "product_added_to_cart",
  "visitor_id": "uuid-or-hash",
  "session_id": "uuid",
  "ts": "iso8601",
  "url": "https://example.com/product/123",
  "referrer": "https://google.com/search?q=...",
  "device_type": "desktop",
  "browser": "Chrome",
  "visitor_language": "en-US",
  "props": { "product_id": "123", "value": 49.90, "currency": "EUR" }
}
```

- `visitor_id` and `session_id` are always assigned by the server (see
  "Visitor identification" and "Session logic" below) — the client script
  never generates or sends either. This keeps the client script minimal
  and makes the server the single source of truth for identity.
- `consent` is an *optional* boolean the client script sends per
  request, reflecting whatever consent state the client site's own
  cookie-consent setup (if any) has communicated to it — `true`,
  `false`, or omitted entirely when it hasn't answered yet. All three
  matter: see "Visitor identification" below for why omitted must not
  be treated the same as `false`. Persisted on the stored row as
  `consent_mode` (`"consentful"`/`"consentless"`) — previously this was
  used only to pick a `visitor_id` strategy and then discarded, so there
  was no way to later answer "was this row collected with the visitor's
  consent?". That column stays two-valued and `NOT NULL` even though the
  wire field is three-valued: `consent_mode` describes which
  *identification method* a row actually used (a persistent cookie id,
  or the ephemeral hash), which is a strictly narrower question than
  what this one request's own `consent` field said — an omitted-consent
  request identified via an existing cookie is still `consentful`, since
  a persistent id was genuinely used. `db/events.ts` still defaults
  `consentMode` to `"consentless"` if a caller ever omits it, but
  `routes/events.ts` always computes and passes one explicitly now.
- `referrer` is the browser's `document.referrer` — it must be sent
  explicitly by the client script; the server cannot derive it (the HTTP
  `Referer` header the server sees on the `/events` request only reflects
  the tracked page itself, i.e. the same thing already in `url`, not
  where the visitor came from before landing on the site).
- `idempotencyKey` is optional, omitted from most events — a value the
  *deployment* supplies (via `track()`'s third argument) that uniquely
  identifies this real-world occurrence, e.g. an order id. It exists to
  stop a refreshed or back-navigated confirmation page from double-
  firing a revenue event and double-counting toward `get_property_sum`:
  a second event with the same `(event, idempotencyKey)` pair is
  silently dropped (`idx_events_dedup`, a partial unique index —
  `db/migrations.ts`) rather than inserted as a second row. It lives
  on the envelope, not in `props`, for the same reason `consent` does:
  it's fixed metadata that means the same thing regardless of event
  type, not something this project needs to know the shape of. The
  client script can't generate this itself — a client-generated value
  would differ on every refresh and defeat the whole point, since it has
  to identify the real event, not the beacon that reports it.
- No `utm_source`/`utm_medium`/`utm_campaign`/etc. columns — deliberately
  not parsed out at ingestion. `url` keeps its query string rather than
  being split into named columns, which would be an opinionated
  attribution model (which params matter, how to handle
  missing/malformed ones) this project isn't taking a stance on.

  **The query string is filtered, though** (`lib/url.ts`'s
  `stripUnknownParams`, applied to `url` and `referrer` at ingestion,
  and by the client script before it sends at all). Only the campaign
  and click-id parameters survive; everything else is dropped. This
  reverses an earlier "stored in full" decision, because storing it in
  full meant a newsletter link's `?email=`, a password reset's
  single-use token and a site search's typed query all landed in the
  database — and `get_recent_events` reads stored URLs back verbatim, so
  for a hosted assistant they left the server entirely. An allowlist
  rather than a denylist of dangerous names, because forgetting to allow
  a parameter loses analytics data visibly and recoverably, while
  forgetting to deny one leaks a secret silently and permanently. What is parsed, at query time, not ingestion (`lib/url.ts`'s
  `parseUrl`, used by `getTopPages`): the structural split into `path`,
  `params` (the raw query string, still unopinionated about individual
  params), and `hash` — needed so e.g. `/blog/post-1?utm_source=x` and
  `/blog/post-1?utm_source=y` are counted as the same page, not two.
  Deliberately kept as a query-time computation, not stored columns:
  `parseUrl` is a pure function over the one source of truth (`url`), so
  a future fix to its logic instantly applies to all historical data.
  Stored columns would need a backfill migration every time that logic
  changed, and today's data volume doesn't need the query-time cost
  saved by skipping that computation — only reconsider this if a real
  deployment's event volume actually makes `getTopPages` measurably
  slow, not preemptively.
- `device_type`, `browser` and `visitor_language` are likewise never
  sent by the client script — they come from headers that arrive on
  every HTTP request (`User-Agent` and `Accept-Language`) and are
  captured server-side at ingestion. The User-Agent header is not
  stored: `lib/userAgent.ts` classifies it at write time and only the
  two results are kept (see "Device class instead of the User-Agent
  string" below for why this replaced storing the raw string).
  `visitor_language` is the primary tag
  parsed from `Accept-Language` (e.g. `en-US`) — the visitor's browser/
  device locale preference. This is distinct from a `document_language`
  *prop* an event may declare (e.g. `page_view`'s), which is the page's
  own declared language (`document.documentElement.lang`) and can only
  be read client-side.
- `ts` is never sent by the client script either — the server stamps it at
  receipt time, the single source of truth. Same reasoning as identity:
  a client-supplied timestamp can't be trusted, and at this project's
  traffic scale the (rare) gap between an interaction and its beacon
  arriving is not worth tracking separately.
- **Day-bucketing is UTC only, deliberately not configurable.**
  `getTrafficByDay` (the cockpit's trend chart) groups events by
  calendar day via SQLite's `strftime('%Y-%m-%d', ts)`, which is always
  UTC. For a deployment whose visitors are far from UTC, a day's
  activity can appear split across two bars, or "today" on the
  cockpit can roll over a few hours off from the site owner's actual
  midnight. A per-deployment timezone would fix this, but `strftime`
  can't group by an IANA zone (only a fixed offset, which breaks across
  DST) — doing it properly means bucketing in JS instead of SQL, real
  effort for a cockpit-only cosmetic edge case nobody's hit yet.
  Documented here instead of fixed; revisit only if a real deployment
  finds it actually confusing.
- **Every envelope string is length-capped, and `url` must be a real
  URL** (`schema-registry/envelope.ts`). Nothing enforced a maximum
  before: a single request could store ~90KB of junk in one row
  (verified — a 30,000-character url, referrer and prop all validated
  and were written). With `/events` accepting 60 requests a minute per
  IP and `RETENTION_DAYS` optional, that's a slow disk-exhaustion path
  on a deployment whose entire database is one file on one volume, and
  a full disk takes SQLite down with it. The caps are deliberately
  generous (2048 for `url`/`referrer`, the de facto browser ceiling) —
  they exist to bound abuse, not to second-guess real data.

  `url` is also validated as an absolute URL now, where it used to be a
  bare `z.string()`. The client always sends `location.href`, so this
  only rejects something that was never going to aggregate correctly:
  `lib/url.ts`'s `parseUrl` falls back to using the raw value as the
  "path", so `"not-a-url"` and `"javascript:alert(1)"` were silently
  becoming rows in `get_top_pages`. A rejection is visible in
  `get_top_rejected_events`; nonsense in a ranking is not. `referrer` is
  deliberately *not* URL-validated — `document.referrer` is `""` for a
  direct visitor, which is the common case, not an error.

  `props` are bounded instead by the request body as a whole, capped at
  16KB in `routes/events.ts` (express.json defaults to 100KB). Props are
  open by design, so the size of the whole request is the only sane
  limit on them; individual prop schemas stay the deployment's business.
- Envelope fields are fixed and required — the `lib/` query modules
  only ever need to understand these, never `props`.
- `props` is open per event type, but every event type used in production
  MUST have a corresponding entry in the schema registry (validated at
  ingestion — unknown event types/props are rejected or flagged, not
  silently accepted).

### Device class instead of the User-Agent string

The `User-Agent` header used to be stored raw on every row and
classified at query time (`lib/userAgent.ts`), chosen so that a fix to
the classifier would apply to history without a backfill. Reversed,
prompted by the legal review of the consentless design: the only
question ever asked of that column was "which browser on which
device", and Art. 5(1)(c) minimisation is judged per field against
purpose. A field kept raw when a reduction serves its only purpose is
the textbook finding a DPO can make without engaging the unsettled
§ 25 TDDDG question at all, so it was an easy objection to remove.

Two further reasons, both about what the string can do that the class
cannot. A full User-Agent plus a second-resolution timestamp can single
out one device on a quiet site — a 50-visitor intranet, a niche B2B
page. And it joins cleanly to the reverse-proxy or hosting log an
operator almost always keeps, which holds the full address; "mobile /
Safari" joins to nothing much. Re-linking through the hash was still
possible for whoever held `SALT_SECRET` (today, only for whoever holds
the current day's salt), but a database copy plus a log no longer
re-links on its own by string equality. That is the Art. 4(5) condition, the extra information kept
separately, met in fact rather than argued.

What it does not change: the header still feeds the bot check and the
consentless hash, at request time, and is then dropped. The hash was
never computed from the stored column, so re-linking through it is
exactly as possible as before — this is a minimisation change, not a
re-identification one. `get_device_breakdown` and the cockpit's device
card keep their shape; they read two columns instead of classifying.

What it costs: a classifier improvement no longer fixes old rows.
Plausible made the same trade and stores the parsed form. A row whose
request carried no header at all holds NULL in both columns and is
reported under the same "Other"/"other" bucket an unrecognised header
lands in — the answer to "which device" is unknown either way.

A hard schema edit rather than a migration: nothing is deployed yet,
so migration 0 was changed in place. That is the one thing the APPEND
ONLY rule in `db/migrations.ts` exists to forbid, and it stops being
an option at the first release. A development database created before
this change has the old columns and must be deleted.

## Schema registry

> The `defineEvent`/TypeScript mechanics described in the first half of
> this section are **history**. Events are JSON files now — see "Event
> schemas as JSON files" at the end of the section. What the registry
> holds and why is mostly unchanged, with one substantive exception:
> arrays are no longer banned, they are a declared `list` prop read
> through `json_each`.

One entry per event type: description, each prop's type + meaning +
example value. This is:
1. A Zod schema used to validate incoming events in `routes/events.ts`.
2. An MCP **resource** the agent reads before querying, so it grounds
   itself in the actual event vocabulary instead of guessing.

Metadata (description/example) lives in the registry
declaration itself, defined once per event *type* — never repeated in
the event *payload* sent at runtime, which would bloat every request and
leave nothing stable to validate against. A `defineEvent` helper derives
both the Zod schema and the MCP-facing metadata from one declaration:

```ts
export const internalLinkClick = defineEvent({
  description: "Fired when a visitor clicks an internal navigation link",
  props: {
    target_url: { type: z.string(), description: "URL the link points to", example: "/pricing" },
    link_text:  { type: z.string(), description: "Visible text of the clicked link", example: "Pricing" },
  },
});
```

**Props must be flat scalars — no nested objects, no arrays.**
(Arrays were allowed later, as an explicitly declared `list` prop —
see "Event schemas as JSON files" below. Nested objects still are not.)
`get_by_property`/`get_property_sum` both group or aggregate on a single
`json_extract($.key)` value, which can't reach into a nested object or
usefully compare array values (SQLite returns either as one opaque
serialized string). `defineEvent` enforces this at import time (same
fail-fast spirit as `requireEnv`) by checking each prop's `example`
value — since `example`'s type is `z.infer<T>`, TypeScript already
guarantees it structurally matches whatever the declared Zod type
actually produces, so checking the example is a reliable proxy for the
prop's real shape without needing to introspect Zod's internal type
tree. A prop needing structure (e.g. an order) should be split into
separate flat props (`order_total`, `order_currency`), not nested.

**Each prop's metadata also includes its declared `type` (`string`/
`number`/`boolean`/`null`) and whether it's `required`.** Previously the
MCP-facing schema resource only exposed `description` + `example` — an
agent had to guess a prop's type from `typeof example` and had no way
at all to tell a required prop from an optional one, a real blind spot
for a project whose whole pitch is "the agent grounds itself in the
registry before querying." `defineEvent` derives both automatically:
`type` from the same `example` value already used for the flat-scalar
check above, and `required` by checking whether the prop's own Zod type
accepts `undefined` (`prop.type.safeParse(undefined).success`) — a
prop can be `.nullable()` (its *value* can be `null`) without being
`.optional()` (the *key* can be omitted entirely); these are answering
different questions, so `required` reflects optionality specifically,
not nullability.

**Descriptions are enforced, not merely encouraged.** Every registered
event and prop must carry a description of at least a sentence, and so
must every MCP tool (`registry.test.ts`, `mcp/tools.test.ts`). These
run over whatever a deployment actually registers, so a custom event
added by someone tailoring their own instance is held to the same bar
as the built-ins.

The reasoning is that descriptions here are not documentation *around*
the product, they are the product: the registry is what an agent reads
to learn what an event means, and a tool's description is the only
thing telling it which tool to call and how to read the result. A blank
or one-word description doesn't produce an error, it produces a
confident wrong answer — and it is exactly the corner someone
customising a deployment will cut, so it needed to be caught by
something that can't be skimmed past, in the same fail-fast spirit as
`defineEvent`'s flat-scalar check.

Length is a crude proxy and deliberately so: it catches emptiness and
obvious placeholders, which is the whole of what a test can see here.
Whether a description is *accurate* stays a human review job, and
remains this project's likeliest failure mode.

Ship a small set of pre-defined common events out of the box — today
`page_view`, `outbound_link_click` and `file_download`. Adding a new
custom event + its schema entry should take a dev under a minute.

Those three, and only those three, are the ones the bundled client
script fires itself, which is why they are the ones that ship: their
props are a contract with compiled client code rather than a choice a
deployment gets to make. `internal_link_click` shipped alongside them
for a while and was removed — nothing fires it automatically, so it was
an ordinary custom event that happened to live in the image, and
shipping it implied the built-in set was a taxonomy rather than
precisely "what the client sends". The README shows the same schema as
a custom-event example instead.

Name events for what happened, not for which mechanism fired them
(a click, a `data-genug-on-load` attribute, a manual `track()`
call) — the same event name can end up triggered by more than one of
those over time, and a name like `outbound_link_click` fired from a
page-load attribute would describe something that didn't happen.

**No event name is hardcoded as "the" page view, anywhere.** Early on,
`get_top_pages`/`get_top_referrers` filtered on the literal string
`'page_view'` — which directly contradicted the flexible-schema
principle above: a deployment that renamed or removed that event (e.g.
called it `screen_view` instead) would get silently empty results
forever, no error. Fixed via an explicit `pageView: true` flag on
`defineEvent` — at most one registered event may set it (enforced at
import time, same fail-fast spirit as `requireEnv`), and
`get_top_pages`/`get_top_referrers` look up whichever event is tagged
rather than assuming a name. `page_view` carries this tag by default.

**Exactly one event must carry it** — the registry throws at import on
none as well as on more than one. Zero was allowed at first, and that
single permission cost more than the feature it enabled: every traffic
result carried an optional `viewEvents`, the cockpit had to tell "not
configured" from "no data" in two places, `get_top_pages` and its four
siblings each needed an explanatory-error branch, and five tool
descriptions carried a clause the agent reads on every call. All of it
served a deployment that collects via a browser script and tracks no
page views, which does not exist. A deployment that genuinely doesn't
care registers one and never fires it: an empty result then means zero
page views, accurately, which is the ambiguity the optional case was
built to avoid in the first place. Named `pageView`, not `pageLoad`: the flag marks "the event
representing a page being viewed," independent of what fired it (a
real browser page load, an SPA route change with no reload, a manual
`track()` call) — same "name for what happened, not the mechanism"
reasoning as above. `pageLoad` would tie the flag to
one specific mechanism even though it's meant to generalize beyond it.

Same reasoning already applied to `get_traffic_summary`/
`get_segment_summary` (originally a single `pageviews` field,
`page_view`-only) — a deployment tracking nothing but clicks or custom
events would otherwise always see zero there. It went through two
shapes on the way to today's:

1. First, a single `events` field counting *every* event in the
   period/segment. This fixed the always-zero problem, but for the
   common case — a deployment that *does* have an event tagged
   `pageView: true` — it lost the classic pageview number: "how much
   traffic did we get" only had a generic activity count to answer
   with, one that read far busier than actual visits on a site firing
   several custom events per visit.
2. That version then added `pageviews` back *alongside* `events`, but
   `events` still included it — so the two numbers overlapped, and
   anything reading both (a human, or the agent explaining them) could
   easily double-count by adding them together.

**Current shape:** `interactionEvents` (every event that ISN'T the
page-view event) and `viewEvents` (count of whichever event is tagged
`pageView: true`) — additive, not overlapping: they sum to total
activity instead of one containing the other. Named `viewEvents`, not
`pageViews`: the field reports a count of events, not a "views"
metric on its own, and stays clear of "page" phrasing that classic web
analytics tools (Matomo/GA4) attach a more specific meaning to — see
"Current status" at the top of this file re: this being a free rename
made before any real deployment existed. Both tools resolve
`pageViewEventType`, the same tagged event `get_top_pages`/
`get_top_referrers` already key off — one flag, one meaning, reused
everywhere a page-view count is needed. Both fields are always present,
because exactly one event always carries the tag.

### Event schemas as JSON files

**Decided 2026-09.** Event prop schemas moved from TypeScript
(`defineEvent` + one `.ts` file per event) to plain JSON files in
`packages/schema-registry/events/`, one per event, read and checked at
startup. `defineEvent.ts` and `events/*.ts` are gone.

**Why.** Compiled TypeScript means a generic image cannot carry anyone's
events, so every deployment that wants one custom event has to build its
own image. The goal: pull a stock image from a registry, drop JSON files
on a persistent volume, restart, get a customised setup with no build.
Events are read from `EVENTS_PATH` (default `/data/events`) on the
volume. It started as two directories, the image's and the volume's;
"The volume is the only source" below says why that did not survive.

It only covers custom *events*. A custom MCP tool or a changed cockpit
is code and still needs your own image. Adding events is the common case
by a wide margin, which is why it is the one of the three worth
unlocking.

**The format.** One file per event, named for the event — no `_name`
key, because a name and the file holding it are two places to spell the
same thing and they drift. Keys starting with `_` are event metadata
(`_description`, `_note`, and the role tags `_pageView`,
`_automaticOutboundClick`, `_automaticFileDownload`). Every other key is a prop declared
by a dot-separated **rule string** — `"string"`, `"string.long"`,
`"number.optional"` — with a `<prop>_description` and `<prop>_example`
beside it.

Rejected: JSON Schema, which is the real standard for this and is the
nested, verbose format the change exists to escape — a
`{"type":"string","maxLength":512}` object under every prop costs more
to read than it buys, and hand-editability is the entire point. Several
libraries invent shorthands for the same reason (`json-schema-shorthand`
writes `"string!"`), which says the verbosity is widely felt but that
none of them won. `required`/`optional` are borrowed from JSON Schema
and Protobuf for free familiarity; `short`/`long` is the one invented
pair, deliberately naming a number nobody should have to reason about.
Our format is strictly simpler than JSON Schema, so generating JSON
Schema *from* it stays easy if interop ever matters.

Rejected: JSONC. Comments would need a parser dependency or
comment-stripping code; a reserved `_note` key costs neither, and works
on props too (`<prop>_note`).

**What this costs.** `EventType` stops being `keyof typeof
eventRegistry` — a checked union of the built-in names — and becomes
`string`, for every deployment, including one that never touches a
volume. TypeScript also stops catching a schema typo at save time; the
checker catches it at startup instead. That is a real regression in
feedback speed, traded for the format being data. Nothing leaned on the
union for *safety*: an event name arrives from the network as an
arbitrary string and is checked against the registry at runtime either
way.

**What it buys beyond the goal.** "Flat scalars only" stops needing to
be enforced, because the format can barely express a violation.
`defineEvent`'s `acceptsUnboundedString` probed a Zod schema by feeding
it an over-long string to see what happened; a length comparison
replaces it. And a prop-name rule appeared that was previously implicit:
names must match `isValidPropertyKey` (letters, digits, underscores),
because names now come from JSON rather than from TypeScript
identifiers, and a name `json_extract` cannot reach would store fine and
then be invisible to `get_by_property`.

**Strictness is by source, not by "built-in".** (Superseded — with one
source there is nothing for the asymmetry to attach to. See "The volume
is the only source of event schemas" below, and the page-view stand-in
that replaced what this used to buy.) A file that arrived
through a build crashes the server on error; a file dropped on a volume
is skipped and reported. Same rule, no special case naming the
built-ins, and a forker who commits their own event into the image gets
the strict treatment too — correct, since it went through a build. The
checker collects every problem in a file rather than throwing on the
first, because the audience is someone hand-editing on a server who
would otherwise fix one typo per restart.

**A volume file never overrides anything**, by name or by role tag.
(Superseded — there is no longer anything to override, and the role-tag
half of this moved into `loadEvents`. The reasoning is kept because the
role-tag rule still exists, for the same reason, over one directory.) A
name collision is the client-mismatch case to avoid — a `page_view.json`
on the volume quietly replacing the built-in that every deployed client
is already firing. A role-tag collision would be worse than wrong:
`resolveTaggedEvent` throws when two events carry one tag, so without
that check a second `"_pageView": true` on the volume would stop the
server from starting, which is exactly what volume files are not allowed
to do. Both are skipped and reported.

**Skipped files are surfaced in the cockpit** (`/cockpit/data`'s
`schemaErrors`, rendered in the Schema registry card and counted in its
collapsed summary). A skipped file is otherwise indirect rather than
silent: its events keep arriving and keep being rejected as an unknown
type, with nothing anywhere connecting the two. Rejected in two places
at once is the point — the counter climbing, and the file named.

**`EVENTS_PATH` is backed up with the database.** `runBackup` copies the
directory beside each dated `.db` file. They are tiny, the job already
runs daily, and a restore without them is a table full of events nothing
can describe any more — the data without the vocabulary. This also
turned up a latent bug: `pruneOldBackups` called `unlink`, which cannot
remove a directory, so it now uses a recursive `rm`.

Reading `process.env.EVENTS_PATH` from inside the schema-registry
package is a small layering oddity, accepted knowingly. The alternative
is turning the registry from a module-level constant into something the
server constructs and threads through every consumer — a large change
that buys nothing.

**List props.** `list` is a fourth rule word — `"string.list"`,
`"number.list"` — declaring several values of one type in one prop, up
to 50, each capped exactly as a single value of that type would be. It
is allowed on all three types rather than only the ones that look
useful: a uniform rule is less to explain than a carve-out, and
`boolean.list` being pointless is not the same as it being harmful.

Arrays were previously banned outright, for one specific reason:
`json_extract(props,'$.tags')` returns the whole array as one opaque
string, so grouping by it groups by the entire array — `["a","b"]` and
`["b","a"]` would be two different "values". `json_each` expands the
array into one row per value, which is what makes a list queryable at
all. It was already load-bearing in `lib/funnel.ts`.

Two consequences worth stating where they will be read, because both
produce numbers that look wrong:

- `get_by_property` on a list uses `COUNT(DISTINCT events.id)`, so a
  repeated value inside one event counts once. The counts still sum to
  more than the number of events, because one event contributes to
  every value it carries. The tool description says so — an unexplained
  total exceeding the event count reads as a bug.
- `get_property_sum` on a list counts *values*, not events, so
  `sum / count === average` still holds. Also said in the description.

`get_segment_summary`'s property filter took one more step to support.
Comparing `json_extract` to a single value matches nothing for an array
and reports zero sessions — the "empty result that reads as no data"
failure `AGENTS.md` names — so it first returned an explanatory error,
and then got the branch: `EXISTS (SELECT 1 FROM json_each(...) WHERE
value = @value)`, correlated on the outer row.

`EXISTS` rather than a join, deliberately. A join would multiply a row
out once per matching value, inflating every count the tool returns; the
question is whether the event carries the value, asked once. The filter
then means "carries this value among its values" rather than "equals
it", which the tool description says — two filters can match the same
session, which is not how the scalar case behaves.

What a list is *for* is one dimension with several values (tags,
categories, authors). Not several dimensions varying together: parallel
`products` and `prices` arrays pair only by position, nothing can
enforce equal lengths, and revenue-per-product needs that pairing to be
real. Line items stay separate events sharing an `order_id`. The recipe
says which way holds up; how anyone models their data is their own
business.

### The volume is the only source of event schemas

Built. It replaces the two-directory arrangement described above, which
lasted about a week.

**Editing a built-in was impossible, not merely awkward.** Renaming
`page_view` to `seitenaufruf` means a volume file carrying
`"_pageView": true`, and the image's `page_view.json` still carried it,
so the merge rejected the newcomer for claiming a taken role. Nor could
the image copy be edited out of the way: `/app` is deliberately
root-owned and the server runs as uid 1000. So the capability the
role-tag change was made to unlock could not be reached at all.

**Seeding rather than precedence.** On startup, if `EVENTS_PATH` holds
no event files, every event file in the image is copied there; the
registry then reads that directory and nothing else. One source means
there is no precedence, no shadowing and no override semantics to
invent — renaming or deleting a built-in is an ordinary edit to an
ordinary file, which is what it should have been from the start.

**Once, not "whatever is missing".** Copying any image file the volume
lacks is the friendlier-sounding version, and it breaks the exact case
this exists for: renaming `page_view.json` to `seitenaufruf.json`
leaves no `page_view.json` on the volume, so the next restart would
copy it back and two events would carry `_pageView` — which stops the
server. The rejected fix was to teach seeding about role tags, which is
to reintroduce the precedence logic the change exists to delete.

The price is the fork case, which the earlier sketch had handled: an
event committed into your own image does not appear on a volume that
already has files. The answer is to drop it on the volume too, the same
as with a stock image. A recurring rule losing to a one-off
inconvenience is the right way round.

**Two files claiming one role tag** is now checked inside `loadEvents`,
over a single directory, instead of by the deleted `mergeVolumeEvents`.
It has to be checked somewhere: `resolveTaggedEvent` throws on a tie
rather than picking a winner, and the registry is built at import, so
an unchecked duplicate stops the server rather than being skipped like
any other bad file. Files are read in sorted order, so the loser is
decided by name rather than by whatever the filesystem returns. The
rejection quotes the JSON key someone typed
(`_automaticFileDownload`), not the internal role name
(`fileDownload`) — the old message got this wrong and would have sent
the reader looking for a key that does not exist.

**The page-view stand-in** is what the single source needed and the
strictness asymmetry could no longer provide. A broken volume file is
skipped, and a broken *page-view* file leaves nothing carrying
`_pageView` — which the registry refuses to start without, for the
reasons under "Never hardcode page_view". So one typo would have taken
the deployment down by a new route, having closed the old one. Now: if
nothing carries the tag, the image's own page-view event is registered
as a stand-in, and the cockpit is told both that it happened and that
some other error in the same list is the cause. Page views keep being
recorded under the name the client already resolves, and the real
problem surfaces where every other rejected file does.

It cannot paper over a working rename: it runs only when *nothing*
carries the tag. The startup refusal stays as a true last resort, for
the one case the stand-in cannot serve — an event registered under the
built-in page-view name but not carrying its tag.

**No volume, no seeding.** The directory is only created when its
parent already exists. In a container `/data` is the mounted volume and
always does; on a development machine it does not, and creating one
would scatter a stray `/data/events` across laptops and CI holding a
copy of files the clone already has. The image's own directory then
serves as the source, and the cockpit is told — a silent fallback to a
different source is precisely the plausible-but-wrong failure this
project cares most about. It is expected noise when running from a
clone; in a container the same line means the volume is not mounted
where `EVENTS_PATH` says.

**Accepted, and documented rather than engineered around:** an event
you delete comes back if you also empty the directory, and the seeding
step needs `EVENTS_PATH` to be creatable — the same bind-mount
ownership gotcha `DB_PATH` already documents, with the same
`chown -R 1000:1000` fix. A failed copy is reported and the image
serves instead, so the deployment still runs; it just cannot be edited
from the cockpit.

### Reloading event schemas without a restart

Built. `reloadEvents()` re-reads the event directory and swaps the
registry in; the cockpit's Schema registry card has a **Reload event
files** button, backed by `POST /cockpit/reload`.

**It was initially assessed as expensive, and that was wrong.** The
first count said roughly twenty consumers held the registry and would
all have to start asking for it instead. Counted rather than assumed:
nine server modules import it, and **not one reads it at module scope**
— every use is inside a request handler. ES module imports are live
bindings, so `export const eventRegistry` becoming `export let` plus a
function that reassigns it reaches every consumer with no change to any
of them. Verified end to end through this package's own re-export in
`index.ts`, which is the part worth checking rather than assuming, and
then again against the running server: an event file that did not exist
at boot is rejected, reloaded, and accepted, with nothing restarted.

The load-bearing part is now an invariant in `AGENTS.md`, because
nothing would fail if it were broken. A consumer that caches
`eventRegistry` in a module-level constant keeps compiling, keeps
passing its tests, and quietly stops seeing reloads.

**A failed reload changes nothing.** `buildRegistry()` produces a whole
registry or throws, and `reloadEvents` only assigns on success, so a
broken file cannot leave half the registry replaced. It never throws
either: this runs from an HTTP handler on a live server, where taking
the process down over one bad file is exactly the failure that loading
volume files leniently exists to prevent. The caller gets the reason to
display, and the cockpit says "nothing changed" rather than "failed" —
which would read as collection being down when it is still running on
the previous registry.

**What a reload cannot pick up** is `EVENTS_PATH` or any other env var,
which still need a real restart. That is fine; it is not what the
button is for.

**`X-Genug-Cockpit: 1` is required on the POST**, and was originally the
whole CSRF story for this route and the write routes that followed it:
under Basic Auth a browser attached the credentials to a cross-site form
POST by itself, so being authenticated said nothing about where a
request came from. The session cookie that replaced it is
`SameSite=Lax`, which a browser will not send on a cross-site POST at
all — so this header is now the second lock rather than the only one,
kept because the two fail differently. A header a plain form cannot set
forces a preflight, and `/cockpit` answers no CORS preflight. The current impact of a forged reload is admittedly close to
nil — it re-reads files an attacker does not control — but the same
guard is load-bearing the moment the cockpit can write.

**A "restart the container" button was considered instead, and
rejected.** The clean form needs no Docker access at all: the process
exits and Docker's restart policy brings it back. But a deployment
without a restart policy gets "shut down permanently" from a button
labelled Restart, and nothing inside the container can detect which
kind of deployment it is in. The alternative — mounting
`/var/run/docker.sock` — is root-equivalent on the host, which would
undo the Dockerfile's unprivileged user and root-owned `/app`. A reload
has neither problem, loses no events to a restart window, and is less
code.

### Editing an event from the cockpit

Built, and it completes the three-part change the two sections above
started: the volume is the only source, a reload applies a change
without a restart, and the cockpit can now make the change itself.

**Words only.** The form edits the event's name, its description, and
each prop's description and example. Prop names, rule
strings and role tags are read out of the file and written back
untouched. The line is not "what is easy to build" but "what can stop
collection": everything on the editable side is prose an agent reads,
and everything on the other side decides whether an incoming event is
accepted. A browser form that can change a rule string can take a site
off the air with one keystroke, and the file is the right place for
that. `lib/editEvent.ts` enforces it server-side, not just in the page.

Rejected: a raw JSON textarea per event. Complete and much smaller to
build, but it is a text editor in a web page — no better than SSH, and
easier to paste something broken into. Also rejected, for now, a full
structured editor over prop rules: it means rebuilding `parseRule`'s
grammar in the browser, and the first wrong edit silently starts
rejecting live events.

**Nothing reaches disk until the whole edited file passes the loader's
own checker.** A rejected edit therefore costs nothing, rather than
leaving a file the next reload refuses. The same applies to the
sequence: the file is written first, the rows are moved second. The
other order would, on a failed write, leave every row pointing at a
name nothing defines; this way the worst case is rows left under the
old name, which is the ordinary stranded-data case the orphaned-events
panel already reports.

**A cockpit rename knows both names, and that is the whole point.** A
file rename over SSH does not — deleting `page_view` and adding an
unrelated `seitenaufruf` looks identical from inside, which is why the
recipe hands you an `UPDATE` to run yourself. A form has both halves,
so it offers to carry the stored rows across, ticked by default, with
the real all-time count beside it. Default-ticked because leaving rows
behind is the failure this project cares most about: they keep counting
toward totals while matching nothing keyed on a name, so the numbers
stay plausible and the breakdown is wrong.

**Two row-collision cases, and they are not the same.** Verified in a
browser, and the second was found that way rather than by reasoning.

- *Moving rows onto rows already stored under the new name.* Both sets
  end up under one name with nothing able to separate them again.
  Refused, in `editEventFile` and in the form.
- *Renaming onto orphaned rows without moving anything.* Those rows
  become this event's history. This is **reversible** — the two sets
  stay separable by name — and it is usually what someone wants, since
  it is how you undo a rename you did not mean. So it is allowed, but
  the form now says it will happen. It did not at first: the guard only
  covered the checkbox path, and renaming back silently re-adopted
  eight rows with nothing on screen mentioning it.

**A name collision is not a row collision, and the form used to
confuse the two.** Typing the name of an event that already exists
showed the two notices above — including one calling that event's own
live rows orphans "left behind by an earlier rename" — and gave the
real reason only after Save, from the server. Nothing was at risk:
`editEventFile` refuses to write over an existing file, and did. But
the form was describing a rename that could not happen. It now checks
the registry before the stored counts and says the name is taken.
Found by exercising the whole stack against a running server, not by a
failing test — both halves were behaving exactly as written.

**The read-only case is visible, not hidden.** When seeding could not
prepare a volume, `eventsSource` is the image's directory, the Edit
buttons are absent and the card says why. Writing into the image would
be discarded on the next deploy, and a Save button that quietly does
nothing lasting is worse than no button.

**Examples are typed as they read for text props, and as JSON for
everything else.** A text input hands back text, and there is no way to
tell `49.9` from `"49.9"` without consulting the declared type — so the
server consults it. Asking someone to type quotes around a page title
would be absurd; asking them to type `["news", "product"]` for a list
is what the file already looks like.

**`X-Genug-Cockpit: 1` now guards something that matters.** On the
reload route it was close to theatre, since a forged reload re-reads
files an attacker does not control. On a route that renames events and
rewrites rows it is the real thing.

### Creating an event from the cockpit

Built after the editor, and it is the piece that makes the cockpit a
complete answer rather than half of one: you could change an event's
words in a browser but not bring one into existence.

**The words-only line does not apply here, and the reason is traffic,
not effort.** Editing an existing event may not touch prop names, rule
strings or role tags because that event is already being sent: a
changed rule starts rejecting live events, and the rejection looks like
a traffic drop rather than a mistake. A name nothing has ever sent has
no traffic to reject and no history to strand, so the worst a wrong
shape costs is a file you fix before pointing anything at it. That is
the whole difference, and it is why `lib/createEvent.ts` sits beside
`lib/editEvent.ts` rather than inside it.

**The browser still never sends a rule string.** It sends a type picked
from four (`text`, `longText`, `number`, `boolean`) plus two
checkboxes, and the server composes `"string.long.optional"` itself.
That is stronger than validating what a text field contained: the set
of shapes the route can be asked for is closed, so `stringy.verylong`
— which a real test typed into a file and watched get rejected — is not
expressible at all. `long` is one of the four types rather than a third
checkbox for the same reason: `parseRule` rejects `number.long`, and an
option that is invalid in three of four combinations is better not
offered than explained.

**No role tags, either form.** Only one event may carry each, and when
two do, the one that keeps it is decided by name order. Testing this
for real showed what that means: dropping in a `second_pageview.json`
with `_pageView: true` displaced the live page-view event on spelling
alone, stranded its history, and started recording page views under the
new name. A checkbox for that would be a one-click version of the same
thing. Moving a role stays a file edit, where it is deliberate.

**No category, in the form or in the format.** Designing the form made
the question concrete: what would you be asking someone for? A category
was a label. It coloured a pill for the three names the cockpit's map
knew, anything else went grey, and `list_event_types` passed the word
to the agent, which never grouped or filtered by it. A required field
that buys a pill is not worth being the first question of every new
event, and it is not worth being a required field either — so the
format does not have one. An event's shape is its description, its
props and its role tags; how you would file it in a taxonomy is not
something this has an opinion about.

**Examples are typed by their control, not parsed out of text.** A
number prop gets a number input, a true/false prop a two-option select,
and a list prop one row per value with an Add a value button. The edit
form asks for JSON for those cases and that was the right call there —
it is editing values that already exist. Asking someone creating a prop
to type `["news", "product"]` would be asking them to hand-write the
file format the form exists to avoid.

**An event with no props at all is allowed**, and the form says so
rather than looking unfinished. The envelope already records the URL,
the referrer and the time, so "it happened" is a complete event.

**Creating under a name that already has rows discloses it**, the same
way a rename does and for the same reason — those rows become this
event's history the moment it exists, and that is usually the point,
but not something to discover afterwards in the orphaned-events panel.

### Deleting an event, and adding a prop, from the cockpit

Raised by a deployment maintainer who had just created a custom event
through **Register new event**, then realised the form gives no way
back: no way to add a prop they forgot, no way to delete the event if
they change their mind. Both meant SSHing into the host to hand-edit a
file that a browser had just written — the exact "no better than SSH"
gap the cockpit exists to close.

**Not one feature — three, and they sit in different risk tiers.** The
instinct was to treat "let the cockpit manage props and events fully"
as one piece of work. It is not: `packages/schema-registry/src/loadEvents.ts`
builds every event's schema with `z.strictObject`, and that one fact
puts each of the three asks on a different side of the words-only line.

**Adding a prop is safe, provided it is always optional.** A
`strictObject` rejects an unrecognised incoming key, but an absent
*optional* key is not unrecognised — it is just missing, indistinguishable
from any row already stored before the prop existed. A *required* prop
added to an event with live traffic reproduces the exact failure editing
was built to prevent: senders that have not redeployed yet get the whole
event rejected, and it reads as a traffic drop, not a mistake.
`lib/addEventProp.ts` does not trust the caller on this — it composes
the rule as optional unconditionally, so there is no request shape that
reaches the unsafe case, the same defense-in-depth `lib/createEvent.ts`
already uses for role tags. The cockpit form (`addPropForm` in
cockpit.js) reuses `propBlock`, the same one **Register new event**
already had, with the "Required" checkbox simply not rendered rather
than rendered and ignored — a control that would do nothing if you
touched it is worse than no control.

**Deleting a custom event is the scoped sibling of Reset, not a new
kind of danger.** Reset already deletes every event file and re-seeds
the built-ins; `lib/orphanedEvents.ts` already exists specifically to
report what a deleted or renamed event leaves behind. A single-event
delete produces the identical fallout for one name instead of all of
them, so `lib/deleteEvent.ts` does not gate it behind the danger zone's
retyped-password pattern — it follows the disclosure pattern the rename
form already uses instead: the row count that will be orphaned, stated
before the click, not a generic warning.

**A blanket role-tag refusal shipped first, on a claim that turned out
to be wrong, and was caught by using the feature rather than by a
test.** The first version refused to delete any event carrying
`_pageView`, `_automaticOutboundClick` or `_automaticFileDownload`, on
the theory that its traffic would not become visibly orphaned but would
silently recount as a generic interaction. Asked live — "why can I
delete two of these but not the third" — and rereading
`registry.ts`'s `buildRegistry()` to answer it properly showed that
claim does not hold. The client sends a *role*, never a literal name,
for all three of these events (see AGENTS.md); when the role does not
resolve, `routes/events.ts` rejects the event outright as
`unknown_event_type`, naming the missing tag — a clean, visible
rejection for `outboundClick`/`fileDownload`, same as any other
misconfiguration. `_pageView` is different but not silent either:
`buildRegistry()` re-registers the built-in `page_view` as a stand-in
when nothing carries the tag, which is visible in `schemaErrors`, not
hidden.

**What `_pageView` actually risks is narrower, and sharper: a delayed
crash rather than a silent miscount.** The stand-in only applies when
the built-in's own name is free. If some other file already occupies
it — reachable by hand-editing the volume, not through any cockpit form
— `buildRegistry()` throws instead. `reloadEvents()` catches that and
keeps the previous registry serving, so the *running* process survives.
But the file is already unlinked by then, and `buildRegistry()` runs
uncaught at the next process start (`const built = buildRegistry();` at
module load, deliberately fail-fast — see "Two narrower writes" in
AGENTS.md). A server that looked fine after the delete would refuse to
come back up after its next restart. `lib/deleteEvent.ts` does not try
to predict this in advance — that would mean reimplementing
`buildRegistry()`'s own directory-wide resolution inside a
directory-scoped function. Instead `deleteEventFile` deletes and hands
back a `restore()` closure over the exact bytes it removed, and
`routes/cockpit.ts`'s DELETE handler is what actually asks
`reloadEvents()` and calls `restore()` if the real loader refuses the
result — the same "write it, let the checker decide" principle
`lib/editEvent.ts` and `lib/createEvent.ts` use before their own
writes, just necessarily after this one, since only the real loader
reading the whole directory can tell a safe delete from an unsafe one.
Covered by two subprocess tests in `wiring.test.ts` rather than a lib
unit test: `reloadEvents()` reads the module-level `eventsPath`, not
whatever directory a test hands `deleteEventFile`, so the collision
this guards against can only be produced against a real spawned server.

**Deleting a prop was asked for too, and rejected — for now.** It is
structurally the same operation as changing a rule string: removing a
key from `strictObject`'s shape means any client still sending it
(a cached script, a site not yet redeployed) gets its *whole event*
rejected, silently, which is precisely the case the original
words-only design refused to put behind a browser button. A
"no recent occurrences" check was considered and set aside — it is a
weaker guarantee than it sounds, because a cached or undeployed sender
is exactly the case that would not show up as recent. The correct fix
is a deprecate-but-still-accept flag (keep validating the prop if
present, stop requiring or displaying it), which is real scope: a new
schema-file field, a loader change, and cockpit surfacing — more than
one deployment's one-off cleanup justifies today. Stays a file edit.

**Second opinion sought before building any of it**, given it reopens a
line the project had already drawn and argued for once. The three-way
split above is that review's shape, not just this author's.

Was a responsive grid of tiles, each showing a tool's whole
description. A tool description is product surface written for an
agent — several run to a paragraph, `get_orphaned_events` to most of a
screen — so the card was a wall of prose with 27 names buried in it,
and the one question it usually gets asked is "what tools does this
deployment have". Now each tool is a closed `<details>`: the name in
the same code style the props use, one truncated line of description
beside it, and the full text on click.

Truncated by CSS (`text-overflow: ellipsis` on a `nowrap` flex child
with `min-width: 0`), not by cutting the string. Where the text runs
out depends on the width it is rendered at, which only the browser
knows — slicing at some character count would cut short on a phone and
leave a gap on a desktop.

Several can be open at once, deliberately. This is reference material
someone reads while writing a question for their agent, and an
accordion that closes the thing you were comparing against is worse
than one that does not.

### The cockpit stops losing typed work, and stops hiding bad news

Four things from the pre-publish UX review, all in the registry card.

**An open form survived a re-render in name only.** The `editing` and
`creating` flags were kept across `render()`, and the form was then
rebuilt from server data — so Refresh, or a click on 24h/7d/30d, put
stored values back into a form that was still open. A half-written
description vanished; a create form with five props filled in vanished.
Nothing on screen said so, which is the worst part: the form was still
there, so it did not even read as an error. The fix keeps the node
itself, not the flag (`openOrBuildForm`), keyed so that opening a
different event or reopening a cancelled one still starts fresh. Both
buttons sit in the sticky header, always one stray click from an open
form, so this was not a rare path.

**The two warnings that mean "the numbers above are wrong" were
invisible.** Schema errors and orphaned rows both render inside the
registry card, which is closed on load, and the only outward sign was
grey muted text. Orphaned rows are the worse case: they still count
toward totals, so every number stays plausible while being wrong, and
the stat strip stays calm. The card's summary count now names each
problem in red, and the card opens itself the first time a load finds
one — the first time only. Reopening a card someone deliberately closed,
on every refresh, is its own kind of broken.

**A directory that could not be prepared was filed under "N event files
were rejected".** Nothing was rejected: the volume could not be written,
so the whole deployment is reading from the image and no edit will
persist. `SchemaFileError` gained an optional `directory` flag rather
than the cockpit sniffing the filename, and the panel gives that case
its own heading — which is what `refusesWrite` has always promised the
card would say.

**Labels were not labels.** Every field built `<label>` as a sibling of
its input with no `for`/`id` pair, so clicking the text did nothing and
a screen reader announced an unlabelled box across the whole create and
edit flow. One `field()` helper now pairs them. The example rows keep an
`ariaLabel` per control instead, because they come and go with the list
checkbox and a label can only point at one thing.

**And prop blocks are numbered**, because the server's validation error
names one: zod says `props.2.example`, which is the third block on
screen. The route translates that to "prop 3" on the way out rather than
making anyone count from zero — the index is an implementation detail of
the wire format, not something the form should teach.

### Jump links, not tabs

Proposed: one card as the main content, with Overview / Traffic /
Events / Configuration as tabs above it, to make the page feel less
overwhelming. Rejected after a UX review of the actual screenshot.

At desktop width the page is about two screens, and the first one is
the product: the four tiles, the consent line, the trend chart and the
three breakdowns. Everything below is conditional (the rejected card
is hidden at zero), five rows, or already collapsed. Tabs would have
cost the thing the page exists for — the chart behind a click — and
would have re-hidden the two warnings the previous review made
visible: the schema card's red summary and its one-time auto-open both
happen inside a panel nobody can see when another tab is selected.
Getting back to parity means badges with counts and screen-reader
text, plus a decision on whether the auto-open switches tabs. A
correct tablist in plain DOM is another fifty-odd lines of roving
tabindex and arrow-key handling, all hand-tested.

What a phone actually suffers from is length: five or six screens
with Configuration at the bottom. Three jump links under the error
banner fix that with no JavaScript, no state, nothing hidden and
native keyboard behaviour. Three, not four: the row is not sticky, so
it is only ever seen at the top of the page, where Overview is already
on screen — a link to it moved the page by a few pixels, and dropping
it lets the row fit a phone in one line. They sit in the content, not the sticky
header, because once the header wraps on a phone every sticky pixel
is lost viewport. The area labels get `scroll-margin-top` so a jump
does not park the label under the header; a static value rather than
the measured one `showError` computes, since a link runs no script and
being a few pixels off costs air, not a hidden label.

Also considered and left alone: collapsing Events by default (Recent
events is the "is data arriving right now" check, part of "is this
healthy"), and tabs for Configuration only (three closed accordions are
already three lines).

### Still open, in the order we intend to do it

Nothing. Both items that stood here are done:

1. ~~**Publishing an image to a registry.**~~ Done:
   `.github/workflows/ci.yml`'s `publish-image` job runs on a `v*` tag,
   after `build-and-test` passes on that same tag, and pushes
   `ghcr.io/datapip/genug-analytics:<tag>` stamped with
   `GENUG_VERSION=<tag>`. A plain push to `main` publishes nothing —
   see "Releasing a version".

2. ~~**A stock-image deployment path in the README.**~~ Done: the
   README's quick start and `docs/deploying.md`'s Coolify compose
   example both pull `ghcr.io/datapip/genug-analytics:v0.3.0` rather
   than building. Cloning and building your own image is still
   documented, but it is no longer the only route.


## Visitor identification (privacy modes)

Selected per-request by the `consent` field the client script sends
(reflecting the client site's own consent/cookie-banner state, if any —
wiring up an actual consent-management UI is out of scope for v1, see
"Explicitly out of scope"). Three wire values, not two — this is the
one place in the data model where the distinction between `false` and
*absent* is load-bearing rather than cosmetic:

- **`consent: false` — an explicit decline or withdrawal.** No cookie is
  set, and any cookie already on the request is ignored for
  identification and actively removed. `visitor_id` is a hash of
  `IP + User-Agent + daily rotating salt`. The salt is random, one per
  UTC day, and replaced at midnight (see "The daily salt is random"
  below). No per-visitor state persists anywhere. Rotating daily means the same visitor gets a new
  `visitor_id` each day — an accepted privacy tradeoff, not a bug. A
  session that happens to cross midnight will split into two; also an
  accepted edge case, not something to special-case. See "Withdrawal"
  below for the removal itself.
- **`consent` omitted — not yet answered.** A consent manager that
  hasn't resolved yet, or a deployment with no banner at all. If a
  cookie is already on the request, it wins outright and the row is
  recorded `consentful` (see "The priority rule" below); with no
  cookie, this behaves exactly like an explicit `false` — same hash,
  no cookie set, recorded `consentless`.
- **`consent: true` — an explicit yes.** The server assigns a
  persistent `visitor_id` and sets it via `Set-Cookie` (host-only,
  `Secure`, `SameSite=Lax`, 13-month expiry) on the first response, then
  reads it back on subsequent requests. This is the "normal" analytics
  cookie model. The value is not a fresh random id: it is the same
  daily hash that request would have been given consentlessly, frozen
  into the cookie — see "Consentless → consentful transition" below for
  why that merges the visitor's earlier same-day events for free.

  **That cookie is validated on the way back in**
  (`lib/identity.ts`'s `isIssuedVisitorId`), not trusted verbatim as it
  originally was. It's `httpOnly`, so page JS can't set it — but any
  HTTP client can put whatever it likes in a `Cookie` header, and the
  value went straight into the `visitor_id` column. Guessing a real
  visitor's id is impractical (it's an HMAC keyed by the daily salt), so
  the exposure was never impersonation; it was that sending a fresh
  random value per request manufactured unlimited distinct "visitors"
  and sessions, at unbounded string length per row. Anything that isn't
  the shape this server actually mints (a 64-character lowercase hex
  digest) is ignored, and the request falls through to the derived hash
  as if no cookie had been sent.

  This narrows the hole rather than closing it completely: a caller can
  still supply a *well-formed* 64-hex value that this server never
  issued, and it's accepted because nothing distinguishes it from a real
  one. Closing that entirely would mean signing the cookie (storing
  `id.hmac` and verifying the signature), which is a cookie-format
  change worth doing only if fabricated visitors ever turn out to
  matter in practice — the rate limiter already bounds how fast anyone
  could manufacture them.

**Withdrawal.** A request arriving with an explicit `consent: false`
that still carries a `genug_vid` cookie gets a `clearCookie` on the
response. Without this, `setConsent(false)` only flipped a local
boolean: the visitor kept a 400-day identifier on their device, and
because the cookie is `httpOnly` and host-only on the collector
subdomain, the tracked site's own JavaScript could not remove it
either. Art. 7(3) DSGVO requires withdrawal to be as easy as consenting,
and this is the only place able to honour it.

Deliberately not a dedicated withdrawal endpoint. A separate signal,
fired only from `setConsent(false)`'s own call site, was considered
again when the bug below was fixed — it would guarantee removal even
for a visitor who rejects and then triggers no further event that
session, which today's approach only achieves "usually within seconds"
(the README says so plainly). Rejected again: it's a second wire shape
and request path dedicated to one edge case that's already accepted as
acceptable, where the fix below reaches the actual bug with a smaller
change to the one request shape that already exists.

**The priority rule.** `consent: true` or omitted both let an existing
cookie win outright for identification, and only an explicit `false`
distrusts and removes one. This is not the original design — it used
to be a straight two-way split (`if (envelope.consent)`), which meant
*omitted* and *explicit false* were indistinguishable and both cleared
any cookie present. That was found to be a real bug, not a theoretical
one: reproduced over real HTTP against the running server, including
across an actual salt rotation (restarting the process with a different
`SALT_SECRET`, which is mechanically identical to a real day boundary
for `consentlessVisitorId`). A returning, already-consented visitor
whose site's consent manager answers *after* the automatic page-view
fires sends that first request with `consent` omitted rather than
`false` — but the old code treated that identically to a rejection,
clearing the real cookie. If the browser applied that clear before the
next (consent-confirming) request went out, the visitor's persistent id
was permanently replaced with a fresh one: not a lost event, but a
silently broken continuity that would never surface as an error, only
as `get_new_vs_returning_visitors` and any funnel spanning that visit
being quietly wrong for that one visitor.

The fix treats "not yet answered" as a real third state rather than
coercing it to `false` (`envelopeSchema`'s `consent` has no `.default()`
any more, and the client no longer forces it to a boolean either).
Trusting an existing cookie on an omitted-consent request is not a
guess: the cookie's mere presence already proves this browser consented
before, and only an explicit "no" removes that trust — which is also
why such a row is recorded `consentful` even though this particular
request didn't itself confirm consent (see the `consent_mode` note
above). A first-time visitor who hasn't answered and has no cookie
still gets the ordinary ephemeral hash and nothing is set, exactly as
before — the only visitor this changes anything for is one who already
had a reason to be trusted.

**Consentless → consentful transition:** when a request has
`consent: true` but no existing visitor_id cookie yet, the server does
NOT mint a fresh random UUID. It computes the same hash that request
would get under consentless mode (`IP + UA + today's salt`) and freezes
*that* value into the persistent cookie instead. Since it's the same
value, any of that visitor's earlier consentless events from later today
(same IP/UA) already share that `visitor_id` — the profile merges for
free, with no backfill or rewrite of stored rows.

This is same-day, best-effort only, by design:
- No merging across days — yesterday's consentless hash used a different
  daily salt, so there's no retroactive link to pre-consent history from
  prior days. Same accepted tradeoff as the midnight session-split case
  above, not a bug.
- Not guaranteed even within the same day — if IP or UA changed earlier
  that day, the merge misses it, same as consentless correlation already
  can.
- Because the visitor_id value itself doesn't change at the moment
  consent is granted, the "new session on visitor_id change" rule above
  doesn't fire — the session carries through the transition uninterrupted.

This is an identification *mechanism*, not a consent-management system —
the `consent` field is simply how the client script reports whatever
consent state already exists; deciding that state is the client site's
own responsibility.

### An opt-out, and an address narrowed before it is hashed

Prompted by checking a set of claims about this project's privacy
posture against the code. Most held up; two did not, and both are now
true rather than aspirational.

**The address is truncated before hashing: IPv4 to /24, IPv6 to /48.**
The claim being checked said this already happened. It did not — the
full address went into the HMAC, and only the fact that it was never
*stored* was true. Truncating matters because the hash is reproducible
by anyone holding the day's salt: with a full address, "was this exact
person here today" is answerable; with a block, only "was someone from
this block here". That is the difference a supervisory authority is
looking at when an operator relies on legitimate interest rather than
consent.

/48 for IPv6, not the /112 that "drop the last two octets" would give.
A single household is normally handed a whole /64, so keeping one would
identify exactly what dropping the last IPv4 octet exists to stop
identifying. /48 is the block-of-customers analogue of /24.

**The cost is real and one-directional**, and the README says so rather
than selling the change as free. Two visitors who share a block *and* a
User-Agent become one visitor — and one session, since `resolveSessionId`
keys on `visitor_id` and a 30-minute gap. So visitors and sessions come
out under-counted and events-per-session over-counted. The User-Agent
carries enough entropy (browser, OS, versions) that this stays rare on
an ordinary site, and mobile CGNAT and office NAT already collided
before this change. Only the hash gets the narrowed address: the rate
limiter and the cockpit's auth lockout still see the full one, because
throttling a /24 would throttle a whole office for one abuser.

**`optOut()` is the objection route that was missing.** A deployment
relying on Art. 6(1)(f) owes visitors an Art. 21 way to object, and
there was none: `setConsent(false)` only changes *how* someone is
identified — it clears the cookie and consentless collection carries
right on. `optOut()` writes a first-party `genug_optout` flag and the
script goes silent at `send()`, which is the single point every path
funnels through, so no automatic tracker can leak past a gate that only
covered `track()`.

It makes exactly one last request, and that is a deliberate exception
to "sends nothing". The visitor-id cookie is `HttpOnly`, so the tracked
site's own JavaScript cannot delete it and only a response from the
collector can. The alternative — go silent immediately and leave the
cookie to expire in 13 months — is defensible, since nothing would ever
read it again, but "opt out" should mean the identifier actually leaves
the device. The request carries no event, no URL and no referrer, and
`routes/events.ts` short-circuits on it before the envelope is parsed:
it never becomes a row, not even a rejected one. Its schema is strict,
so an event body cannot smuggle the flag in and clear someone's cookie.

Built once without that request, on the reading that a complete opt-out
should mean no contact at all, and put back: the cookie is the thing a
visitor would actually want gone, and leaving it to expire over 13
months to save one request is the worse trade. What the script cannot
help is that the `<script src>` tag is already a request to the
collector — a site that wants none has to stop rendering the tag.

Storing the flag is itself writing to a device, which is the thing
consentless mode otherwise avoids. There is no way around it: a request
not to be tracked cannot be honoured without remembering it, and that
is the case § 25(2) TDDDG exempts.

**Checked in a real browser, not only in jsdom**: page view recorded,
opt out, then a manual `track()` and a fresh navigation both silent and
nothing new in the database. Opting back in produced a page view that
was *consentless* under a new `visitor_id`, which is how you can tell
from the outside that the old cookie really was cleared.

Left alone deliberately: no `Do-Not-Track` or `Sec-GPC` handling. DNT
is dead — Firefox dropped the toggle — and GPC is a US "sale of data"
signal rather than an Art. 21 objection. Honouring a header nobody sends
would look like a feature while doing nothing.

### The daily salt is random

Decided 2026-09-24. The salt used to be `HMAC(SALT_SECRET, date)`.
`SALT_SECRET` never changed, so whoever held it could rebuild the salt
for any past day, and with a known address and User-Agent, that day's
`visitor_id`. The daily rotation then only stopped linking across days
inside the database. It did not stop the operator linking an old ID
back to an address.

Now the salt is 32 random bytes, one per UTC day
(`lib/dailySalt.ts`). At midnight a new one replaces it, and nothing
keeps the old one. A minute timer rotates it even with no traffic, so
yesterday's salt does not wait for the first visitor. Nothing a visitor
sees changes: same-day visits still share an ID, the consent cookie
still freezes that day's hash, and a session crossing midnight still
splits, as before.

**Kept in a file, not only in memory.** In memory, every restart during
the day would start a new salt, and each visitor on the site at that
moment would count twice, with their session cut in two. A deploy is a
restart. So the salt sits in `daily-salt.json` beside the database,
mode 0600, written by write-then-rename so the old value is replaced
at once. The backup copies the database, events and context
directories, never this file, so no snapshot holds an old salt. A
volume snapshot taken by the host holds only that day's salt. If the
file cannot be written, collection carries on with the salt in memory,
and the old file is deleted rather than left in place: a failed write
must not keep yesterday's salt. The cost is only a split on the next
restart. A stopped server rotates nothing, so the last day's salt sits
on the volume until the next start; `operations.md` says to delete it
when shutting down for good.

**`SALT_SECRET` is simply no longer read**, with no startup check or
warning: the maintainer was the only deployment when this changed. The
secret still rebuilds every ID made before the upgrade, and consent
cookies issued before it keep that old ID: the cookie is re-set on each
visit, and an old value cannot be told from a new one. Renaming the
cookie would cut those loose, at the cost of one break in every
consented visitor's history. Not done: destroying the secret does the
same job. The upgrade itself starts a new salt, so
visitors seen before the upgrade get a new ID on their next event that
day, the same as crossing midnight.

**The docs put no legal label on the data.** Whether this changes the
data's status in law is not settled: rows still hold URL, referrer and
a second-resolution timestamp, which a web server log with full
addresses can match. So the docs state the mechanism — what can be
recomputed, by whom, and until when — and leave the label to counsel.

## Session logic (keep intentionally simple)

Computed entirely server-side (events route / `lib/session.ts`) — the
client script has no session concept and never sends a `session_id`. On each
incoming event, the server looks up the visitor's most recent event and
decides whether to reuse or mint a new `session_id`:

- 30-minute inactivity timeout → new session.
- New session whenever `visitor_id` itself changes (e.g. daily salt
  rotation in consentless mode) — a new identity always means a new
  session.
- Deliberately **not** resetting on referrer/UTM change: `document.
  referrer` changes on every internal navigation (page 2's referrer is
  page 1's URL), so comparing it naively would fragment almost every
  session. Detecting a genuine new *traffic source* mid-session would
  need attribution-aware comparison logic — real complexity for a
  signal that isn't actually lost: `referrer` and the full `url`
  (query string included) are stored on every event row anyway (see
  "Data model"), so a mid-session source change is fully recoverable
  from the raw events within a session without the session boundary
  itself needing to encode it.
- No multi-signal GA4-style session model — that complexity serves
  analyst-level queries nobody here will make.

## Client script delivery mechanism

`navigator.sendBeacon`, primary, with a `fetch` fallback for the rare
browser where it's unavailable — the standard pattern used by other
privacy-friendly trackers (Plausible, Fathom, etc.):

- Built for exactly this: fires telemetry that must survive page
  unload/navigation without blocking it. Plain `fetch` (even with
  `keepalive: true`) has had real unload-reliability gaps in some
  browsers; `sendBeacon` has been solid there for longer.
- Includes cookies by default, on every origin, with no extra config —
  `fetch` requires remembering `credentials: "include"` for the
  cross-subdomain case the visitor-id cookie depends on; `sendBeacon`
  just does it.
- One API, used uniformly for every event — no branching between a
  "normal" send path and an "unload" send path, which keeps the client
  script minimal.
- Pass a `Blob` with `type: "application/json"` as the payload — this
  sets the `Content-Type` header correctly so `express.json()` parses it
  with zero server-side special-casing. The server doesn't need to know
  or care which transport delivered a given request.

## Client script embedding contract

The client script (`packages/client`) is a single import-free file,
compiled as a classic (non-module) script — no bundler needed, works via
a plain `<script src="...">` tag with no `type="module"` attribute
required. `/server` serves the compiled file at `GET /client.js`
(`index.ts`) — named generically, not `tracker.js`, since ad-blocker
filter lists (EasyList/EasyPrivacy) block well-known generic tracker
filenames outright. The same reasoning applies one level up, to the
hostname the collector answers on: the examples throughout these docs
use `data.your-domain.com` rather than `analytics.`, `stats.` or
`tracking.`, which those lists match just as readily — see "The
hostname" in [deploying.md](deploying.md). Neither choice hides
anything a visitor could otherwise see: the script is first-party, sets
no cookie in consentless mode, and honours its own opt-out either way.

- **Endpoint auto-detection:** the script reads its own `<script>` tag's
  URL (`document.currentScript.src`) and derives the collector's origin
  from it — no separate config attribute needed (unlike Plausible's
  `data-domain`), since single-tenant means there's only ever one
  possible destination anyway (see "Tenancy").

  The README embeds the tag with `defer`, and that is safe:
  `document.currentScript` is set for any classic script, deferred ones
  included (it is null only for modules and for code running from a
  callback). Verified by loading the compiled file from a real HTTP
  server in jsdom both ways. Don't drop the attribute believing it
  breaks detection — the reason it is there is under "Release reviews"
  in this file.
- **Public API**, attached to `window.genugAnalytics` once the script runs:
  - `track(event, props, idempotencyKey?)` — sends any event. The third
    argument is optional and only matters for events where firing twice
    would double-count (see `idempotencyKey` in "Data model") — most
    calls omit it.
  - `setConsent(consent: boolean)` — updates consent for all subsequent
    `track()` calls (e.g. from a cookie-banner's "Accept" callback),
    without needing a page reload.
- **A documented pre-load stub** (see README's "Calling `track()`
  before the script has loaded"). `client.js` is a separate request, so
  a site's own inline code can easily run before it arrives, and calling
  a method on an undefined `window.genugAnalytics` throws — the standard
  failure mode every mainstream tracker ships a shim for. The site
  defines `window.genugAnalytics` up front with `track`/`setConsent`
  methods that only push their arguments onto a `q` array; this script
  replays them in order on init and replaces the stub outright.

  Replayed **before** any automatic page-load event fires, which is the
  part that matters beyond tidiness: a cookie banner that called
  `setConsent(true)` before this script loaded has to take effect
  before the `page_view` it precedes, or that first event is recorded
  as consentless when the visitor had already agreed. An unrecognized
  method name in the queue warns and is skipped rather than throwing,
  same reasoning as malformed `data-genug-props` — the stub is
  hand-written plain JS on someone else's page, so a typo there
  shouldn't take the rest of the queue down with it.
- **Initial consent state**: read once from
  `window.genugAnalyticsConfig.consent` (a global object the site can set
  inline, before the client script's own `<script>` tag, if it already
  knows the visitor's consent state at load time) and applied to every
  event this script sends, including any automatic page-load event (see
  below). Left `undefined` if unset, not coerced to `false` — the two
  mean different things to the server (see "Visitor identification").
- **Zero-JS tracking via data attributes**, for the common case of
  "track this click" without writing any JS: tag any element with
  `data-genug-on-click="event_name"` and optionally
  `data-genug-props='{"key":"value"}'` (a JSON string). A single
  delegated `click` listener (using `.closest()`, so clicking an icon
  *inside* the tagged element still counts) calls `track()` for it.
  Malformed JSON in `data-genug-props` logs a console warning and
  sends empty props rather than crashing the click — the usual props
  schema validation still applies server-side, so a genuinely required
  prop that's missing is still rejected the normal way.
- **Automatic page-load tracking** — nothing fires on load by default;
  a site opts in one of two ways, checked in this order:
  1. **`data-genug-on-load="event_name"`** (+ optional
     `data-genug-props`, same JSON-string convention as the click
     attributes above) on `<html>` — not `<body>`, which may not exist
     yet if the script runs before it's parsed. Presence alone is the
     opt-in, same as `data-genug-on-click` for clicks — no config
     flag needed. Fires that named custom event once, at load.
  2. **`window.genugAnalyticsConfig.enableAutoPageTracking = true`** — only
     checked if the attribute above isn't present. Fires the built-in
     `page_view` event, `props: { page_title: document.title,
     document_language: document.documentElement.lang }`.

  If neither is set, no automatic event fires — call `track()` yourself
  whenever you want. If a page somehow sets both, the attribute wins
  and the generic `page_view` is skipped, so a load never fires twice.

- **Automatic outbound-link and file-download tracking** —
  `window.genugAnalyticsConfig.enableAutoLinkTracking = true`, off by
  default, mirroring `enableAutoPageTracking` above. Fires the built-in
  `outbound_link_click` (props: `target_url`, `target_host`,
  `link_text`) or `file_download` (props: `file_url`, `file_extension`,
  `link_text`).

  **Why this exists at all**, given `data-genug-on-click` already
  covers "track this click" with no JS: links inside CMS or
  user-generated content can't be hand-tagged, and that's exactly where
  outbound links live. A flag is the only way to reach them.

  Decisions worth recording:
  - **No `outboundClick`/`fileDownload` tag on `defineEvent`**, unlike
    `pageView: true`. That flag exists because `get_top_pages` has to
    ask "which event means a page view here?" without hardcoding a
    name. Nothing needs to ask that about outbound clicks: an agent
    answers "where does my traffic leave to?" with `get_by_property` on
    `target_host`, which already works for any event/prop pair.
    Adding tags — and the dedicated tools that would justify them —
    would be scaffolding for a need that doesn't exist, and the generic
    tool is the same reason `compare_periods` didn't survive.
  - **Download beats outbound** when a link is both (an outbound PDF).
    Downloading the file is what the visitor did; whose server it sat
    on is incidental. One event fires, never both.
  - **`auxclick` is handled alongside `click`**, button 1 only.
    Middle-clicking to "open in new tab" is a normal way to follow an
    outbound link and fires no plain `click` at all, so without this a
    whole category of the thing being measured would be invisible.
    Button 2 (context menu) is excluded — opening a menu isn't a visit.
  - **File detection is best-effort and says so**, same honesty as
    `isBotUserAgent`: an explicit `download` attribute is unambiguous,
    but beyond that it's an extension list, and a URL's extension is a
    hint rather than a declaration. A download served from an
    extensionless URL is missed unless the link carries the attribute.
  - **Non-http(s) links are ignored entirely** (`mailto:`, `tel:`, bare
    `#anchor`, `javascript:`) — none is an outbound visit or a
    download, so they're left alone rather than guessed at.
  - **Link text is whitespace-collapsed and truncated** (120 chars).
    Otherwise the same link yields a different prop value depending on
    how the page's HTML happened to be indented, fragmenting any
    grouping by it — and a whole paragraph wrapped in an `<a>` would
    become the value.
  - **An explicit `data-genug-on-click` on the link wins**, and the
    automatic event is skipped. Both listeners — the tagged-element one
    and this one — match the same click on a tagged link, so without
    this a single click was recorded *twice*: two identical rows when
    the tag named the same event, or the custom event plus a spurious
    `outbound_link_click` when it named a different one. Same precedence
    `data-genug-on-load` already takes over `enableAutoPageTracking`,
    and for the same stated reason: one action, one event.

    Scoped with `contains()` so it only applies when the tag sits on the
    link itself (or inside it). A tagged *ancestor* still fires both —
    an outbound link inside a `<div data-genug-on-click="card_click">`
    describes two genuinely different things rather than one click
    counted twice, so suppressing either would lose real information.
    An empty `data-genug-on-click=""` fires nothing from the tagged
    listener, so it deliberately doesn't suppress the automatic one
    either, or the click would vanish entirely.

- **Automatic SPA route tracking** —
  `window.genugAnalyticsConfig.enableAutoRouteTracking = true`, off by
  default, mirroring the two flags above. In a single-page app the URL
  changes with no page load, so the load-time page event fires exactly
  once: a visitor who browses ten routes was recorded as seeing one
  page, `get_top_pages` reported only landing pages, and `viewEvents`
  under-counted by however deep people browsed.

  **Route changes run the same `firePageEvent` the load does**, not a
  parallel implementation. That's what makes the
  `data-genug-on-load`-beats-`enableAutoPageTracking` precedence
  apply to a route change by construction, instead of being a second
  set of rules that could drift. It also settles what the flag is:
  additive, repeating whatever page-load tracking is already
  configured, rather than a third thing that fires page views on its
  own. With neither load opt-in set it warns and installs nothing,
  since there would be nothing for a route change to repeat.
  The `<html>` dataset is re-read per call, so a framework that keeps
  `data-genug-on-load` up to date gets per-route props instead of
  the load's values replayed forever.

  Decisions worth recording:
  - **A separate flag, not folded into `enableAutoPageTracking`.** The
    tempting argument for folding in is that a site which never calls
    `pushState` would never notice. But plenty of sites call it for
    things that aren't navigation — a lightbox, a wizard step, filter
    state — and those deployments would collect page views that never
    happened, with nothing on the row to tell them apart from real ones
    afterwards. The two failure modes aren't equally recoverable: a
    deployment that misses this flag under-collects but every number it
    reports is *true*, and setting the flag starts fixing it; a
    deployment that over-collects reports false numbers forever. For a
    tool whose pitch is "ask the agent and trust the answer,"
    quietly-false is the worse half. It also patches a global the site
    owns (below), which shouldn't happen unasked. The discoverability
    cost is real and handled in the README instead, where the
    page-tracking section points at this flag directly.
  - **`pushState` is wrapped; `popstate` is listened for.** The History
    API fires no event of its own when a router navigates — `popstate`
    covers only back/forward — so there's no way to observe a
    `pushState` without replacing it. The Navigation API would give
    this properly, but Firefox hasn't shipped it, so the wrapper would
    still be needed as a fallback: two code paths for no gain today.
  - **`replaceState` is deliberately left alone.** It means "rewrite
    the current entry" — canonicalising a URL, stripping a token,
    storing filter state — which is not a visit. This also removes the
    single largest source of false positives, since storing state in
    the URL without adding a history entry is exactly what it's for.
  - **Hash-only changes don't count**, via either trigger. `#faq` →
    `#pricing` is an in-page jump, and counting it would fire a page
    event for every anchor link and "back to top" button — the same
    line the automatic link tracking already draws by ignoring bare
    `#anchor` links. The cost is that hash-routed SPAs (`#/about`)
    aren't tracked at all: a documented gap, revisited only if a real
    deployment needs them.
  - **The event fires on the next tick, not inline.** Three reasons,
    and the second is the one that justifies it on its own: frameworks
    set `document.title` *after* the route change, so firing
    immediately records the previous page's title against the new URL;
    a route guard redirecting `/old` → `/new` calls `pushState` twice
    in one tick, and coalescing records one event at the URL the
    visitor actually landed on rather than two, one of which they never
    saw; and it gives the unchanged-route check somewhere to sit.
  - **`document.referrer` doesn't change on a route change** — it stays
    whichever external site sent the visitor. Correct for attribution
    (the source really is still Google), but it means these events
    can't report the previous route. Not a gap worth closing: `url` is
    stored on every event, so the sequence is recoverable from the raw
    events, same reasoning as not resetting sessions on referrer change.

- **The client sends a role, not a name, for the three events it fires
  itself.** `{"auto": "outboundClick"}` rather than
  `{"event": "outbound_link_click"}`; `routes/events.ts` resolves it
  against `registry.ts`'s `roleEventNames` and stores the name this
  deployment actually registers.

  **What this fixes is a silent failure.** Originally the client
  hardcoded `"page_view"` while the MCP tools resolved whichever event
  carried the page-view tag, so renaming the event made the two ends
  disagree: the tools looked for the new name, the client kept sending
  the old one, and every event was rejected as `unknown_event_type`.
  `sendBeacon` never surfaces the response, so the site owner saw
  nothing at all — no console error, no broken page, just no data.

  That was first fixed by resolving the names server-side and
  **prepending them to `/client.js`** as
  `window.__genugAnalyticsEvents={...}`. It worked, and it cost three
  things. The served file became deployment state rather than code, so
  it could only be cached for five minutes — the cache window doubling
  as the window in which a rename produced rejected events, since a
  cached copy goes on firing the names it was fetched with. It needed
  fallbacks in two places, the client's and the registry's, for the
  preamble being absent. And the rename itself needed a documented
  three-deploy dance to avoid losing events.

  Sending the role deletes all three. There is no preamble, so the file
  is byte-identical everywhere and cacheable for an hour (see
  `server/index.ts`); there is nothing deployment-specific in a cached
  copy to go stale, so a rename is just a rename (in the cockpit, or of
  the file); and the fallback names are gone from both places.

  A rejected intermediate: three booleans on the envelope
  (`_automaticOutboundClick: true` and friends, mirroring the schema
  keys). One field with three values cannot contradict itself, and two
  true booleans would have made the stored name depend on which the
  server read first.

  `event` and `auto` are mutually exclusive and exactly one is required,
  enforced in `envelope.ts`. Everything else — every `track()` call,
  every `data-genug-on-click` attribute — still sends a name, because only
  these three roles exist.

  A role that no registered event carries is rejected as
  `unknown_event_type` with a detail naming the tag to add. The previous
  behaviour fell back to the built-in *name*, which produced the same
  rejection with a less useful reason whenever that name wasn't
  registered either.

  **All three resolve identically, through role tags in the event's
  JSON file** — `_pageView`, `_automaticOutboundClick`,
  `_automaticFileDownload` — read by one shared
  `resolveTaggedEvent(registry, tag)` (registry.ts), which enforces "at
  most one event may carry each tag" at startup, same fail-fast spirit
  as `requireEnv`.

  Two of those keys are named for the client behaviour they switch on,
  because that is all they do: nothing server-side reads either one.
  `_pageView` is not, deliberately — it marks the event that *means* a
  page view, which a dozen queries resolve through, and it has to keep
  working for a deployment firing page views by hand.
  `enableAutoPageTracking` is off by default, so that is the common
  case, and `_automaticPageView` would have named the smaller half of
  its job. The inconsistency is the two kinds of tag being genuinely
  different, not an oversight.

  Only `pageView` existed at first, because only it had a server-side
  consumer: five MCP tools and the `viewEvents` split resolve through
  it. The other two were left untagged on the reasoning that a tag with
  no consumer is scaffolding. That held right up until the client became
  a consumer — and then the asymmetry had a real cost, not an aesthetic
  one: a deployment could rename its page-view event and keep
  `enableAutoPageTracking` working, but renaming the link events made
  `enableAutoLinkTracking` unusable. A non-English deployment, or one
  with a house taxonomy, hit that immediately. Tagging all three makes
  "rename any built-in event freely" a rule rather than a footnote.

  Three booleans rather than a single `role: "pageView" | ...` field:
  the union is more correct (the roles are mutually exclusive by
  construction, whereas booleans permit nonsensically tagging one event
  twice), but `pageView: true` appears throughout this file and the
  code, and the churn buys protection against a mistake nobody would
  plausibly make.

  Role tags never reach the agent — `serializeRegistry` exposes only
  description and props — so this is purely internal wiring.

  **Internal link clicks are deliberately left out of this flag**, even
  though including them would complete the automatic partition (every
  link click being exactly one of download / outbound / internal). The
  split isn't by direction, it's by whether the deployer can realistically
  tag the link:

  - Outbound links and downloads mostly live inside CMS or
    user-generated content. They *can't* be hand-tagged, which is the
    entire justification for automating them.
  - Internal links are the site's own. The deployer knows which ones
    matter and can tag exactly those with `data-genug-on-click`, using an
    event they define themselves (see README). There is deliberately no
    built-in for this: nothing fires it automatically, so it has no
    claim on the image that any other custom event lacks.

  Automating internal clicks would also cost more than it returns:
  roughly double the stored rows on a content site — each internal
  click is immediately followed by the destination's own `page_view`,
  so the pair largely restates what the page_view sequence already
  says — and it would sweep up every `<a href="#">` used as an
  accordion, tab or "back to top" control as though it were a
  navigation. Revisit only if a real deployment finds tagging the links
  it cares about genuinely impractical.

## MCP tool design

Do NOT expose raw SQL or a generic `query_events(sql)` tool — the end
user has no analytics vocabulary, and free-form SQL generation against
the store is a reliability and safety risk.

**Every period bound is normalized before it reaches a query**
(`lib/period.ts`'s `normalizePeriodBound`, applied via a Zod
`.transform()` on the shared `periodInput` in `mcp/tools.ts`). This is
not input hygiene, it's correctness: SQLite has no date type, so every
metrics query compares `ts` as a plain string against timestamps stored
in exactly the shape `new Date().toISOString()` produces. A bound in any
other shape therefore compares *wrongly* rather than failing — and the
failure is invisible. `to: "2026-09-30"` sorts below every real
timestamp on that day, so the entire day silently vanishes from the
result; a timestamp without milliseconds errs the other way and drops
events exactly on the boundary.

That matters far more here than in a normal API, because the caller is
an LLM: a bare `YYYY-MM-DD` is the single most likely thing a model
emits for "last 30 days", and a silently-short answer is one it will
report to the user with full confidence. Normalizing centrally in the
schema (rather than in each of the 23 handlers that take a period)
means no call site can forget, and the agent still sees a plain
`string` in the tool's JSON Schema — the transform runs server-side on
the way in. An unparseable bound comes back as an ordinary tool
validation error the agent can read and retry, not a wrong number.

A bare date is expanded to cover the whole day (`00:00:00.000` for
`from`, `23:59:59.999` for `to`), and is rejected if it doesn't survive
a round-trip — JS silently rolls `2026-02-30` over to March 2nd, which
would quietly widen the window rather than looking like the mistake it
is. That round-trip check deliberately applies only to the date-only
form: a timestamp carrying a UTC offset can legitimately land on a
different calendar day than the one written.

**Two further guards sit alongside that normalization**, both applied
centrally rather than per handler:

- **An inverted period is an error, not an empty result.**
  `from` after `to` used to return `[]` — indistinguishable from "no
  data", which an agent then reports with full confidence. Exactly the
  failure mode normalizing the bounds exists to prevent, so it gets the
  same treatment. Implemented in `mcp/tools.ts`'s `registerTool`
  wrapper, which finds the 23 period-taking tools by their input shape
  rather than a hand-kept list, so a new one is covered the day it's
  written. It can't live in `periodInput` itself: the MCP SDK takes a
  raw shape — a plain object of per-field schemas — with nowhere to
  express a rule spanning two fields.
- **`get_daily_traffic` caps its range at 731 days** (two years, so a
  year-over-year daily comparison still fits). It returns one entry per
  calendar day, so its response grows with the period: an all-time range
  produced 3.65 million entries and a 250MB response, blocking the
  synchronous process for seconds — during which the collector accepts
  nothing.

  Deliberately **not** a blanket cap on every period-taking tool, which
  was the first instinct. Nothing else scales with range: the other
  breakdowns are fixed shapes (7 weekdays, 24 hours) or bounded by their
  own `limit`, and `get_traffic_summary` over ten years is a single
  indexed `COUNT` that's perfectly reasonable to ask for. Refusing it
  would cost real usability for no gain, so the limit sits where the
  cost actually is.

Expose intent-shaped tools instead, e.g.:
- `get_traffic_summary(period)`
- `get_top_pages(period, limit)`
- `get_steps_funnel(steps)`
- `list_event_types()`
- `get_schema(event_type)`

Only `get_traffic_summary`, `get_top_pages`, and `list_event_types` were
committed for v1 (see build order below); `get_schema(event_type)` was
never built as a separate tool since the schema-registry MCP *resource*
already covers that need. One more tool is now implemented beyond v1:

- `get_steps_funnel(steps)` (`lib/funnel.ts`'s `getStepsFunnel`) — how
  many distinct **visitors** (not sessions — a funnel like "viewed a
  product" → "checked out" often spans more than one visit) reached each
  step of an arbitrary, caller-supplied ordered list of registered event
  types, only counting a step if it happened after the visitor's
  previous step. Named `get_steps_funnel`, not `conversion_funnel` (the
  original illustrative name above) — `steps` isn't hardcoded to any
  business model, so a content site could pass `["page_view",
  "newsletter_signup"]` just as validly as an e-commerce site passing a
  cart funnel, and the old name implied a commerce-specific tool this
  isn't. The agent only calls it when the schema registry shows this
  deployment tracks a step-shaped question worth asking, same as any
  other tool. An unknown event name in `steps` returns a helpful error
  listing the valid event types, rather than silently returning zero
  counts (which would look like "no conversions" rather than "you
  typo'd the event name").

  **Its visitor set is queried in chunks** (`MAX_VISITORS_PER_QUERY`,
  `lib/funnel.ts`). Each step filters the visitors still in the funnel
  with an `IN` list, which binds one SQL parameter per visitor, and
  SQLite caps a statement at `SQLITE_MAX_VARIABLE_NUMBER` — 32,766 by
  default. With three fixed parameters alongside them, this threw
  "too many SQL variables" at the agent above exactly 32,763 visitors
  instead of answering. Not a theoretical scale for the target user:
  consentless visitor_ids rotate daily, so roughly 1,100 visitors a day
  over a 30-day window reaches it — and this is the one tool that most
  justifies asking an agent rather than glancing at a dashboard.

  Chunked rather than dropping the `IN` filter and intersecting in JS,
  which would also have removed the limit — but a step on a common event
  (a page view) would then pull every occurrence in the period into
  memory, trading a hard ceiling for an unbounded one. Chunking keeps
  the query indexed and memory bounded by the funnel's own population,
  and is exact rather than approximate: chunks partition visitors, not
  rows, so all of a visitor's events stay in one chunk and per-visitor
  ordering is preserved.

`get_segment_summary` hit the same `SQLITE_MAX_VARIABLE_NUMBER` wall
and was fixed the *other* way, which is worth recording so neither is
"simplified" into the other later. It used to run its filter, pull every
matching `session_id` into JS, and rebind them as an `IN (?, ?, ...)`
list — so it threw "too many SQL variables" past 32,766 sessions.
Chunking would have worked, but the set here is expressible as a
subquery (`session_id IN (SELECT ... )`), which removes the ceiling
instead of raising it and deletes the whole round-trip: `sessions`
becomes a `COUNT(DISTINCT)` the database was always better placed to
compute. `funnel.ts` cannot do that — it has to intersect step by step
in JS, carrying the surviving visitors forward — which is why it
chunks and this doesn't.

It also mattered sooner than the funnel's version: the most natural
question to ask is "sessions where the page-view event happened,"
which is essentially every session in the period, so ~1,100 sessions a
day crossed it inside a 30-day window. The tool broke precisely on
deployments with enough traffic to want it, and never on the test data
of one that didn't.

Three tools answer "what happened"; this one is what makes asking an AI
agent beat glancing at a dashboard for sequenced, multi-step questions
(see "Project maturity & path to a solid product" below).

(`compare_periods(period_a, period_b)` was built and then removed —
see "Project maturity" below for why.)

Three further tools generalize the "breakdown" idea beyond pages, added
once it became clear `get_top_pages` was the only dimension-breakdown
tool that existed; a fourth generalizes `get_traffic_summary` itself
into "traffic for a specific slice of visitors," not just everyone:

- `get_top_referrers(period, limit)` (`lib/content.ts`'s
  `getTopReferrers`) — traffic sources ranked by `page_view` count,
  grouped by the referrer's hostname (e.g. `www.google.com`), not the
  full referrer URL, same reasoning as `get_top_pages` grouping by path
  — a single source like Google Search would otherwise fragment into
  one row per distinct search-result URL. A `host` of `null` means
  direct traffic: the client always sends `document.referrer` (`""` for
  a visitor with no referrer), and an atypical caller that omits the
  field entirely sends SQL `NULL` instead — both mean the same thing and
  merge into one bucket rather than being reported as two. This closes
  a real gap: `referrer` was stored on every event from the start (see
  "Data model") but had no query tool at all before this.

  **Self-referrals are excluded** — added after the first real
  deployment, where the site's own domain came back as the number two
  traffic source. `document.referrer` on the second and every later
  page view of a session is the site's own previous page, so counting
  them ranks the one host that is by definition not a source near the
  top of its own source ranking, and the size of that bogus row grows
  with how engaged the visitors are. The comparison is per row, against
  that event's own `url` host rather than a configured hostname: a
  deployment serving several domains then works with no config, and a
  domain move doesn't silently start counting the old domain as a
  referrer. Apex and `www` fold together; nothing beyond that, because
  telling one of the deployment's own subdomains from an unrelated site
  under a shared parent needs a public suffix list, which is a
  dependency this project won't take for a ranking (see "Dependency
  philosophy"). Dropping these rows rather than reporting them as an
  "internal" bucket is the one place this deliberately hides a number:
  it isn't data a site owner acts on, and the honest version of the
  question is already answered — what survives is each session counted
  at the point it arrived from somewhere else. Note the counts are
  therefore lower than total page views, which the tool description
  says outright.

  **Now counted per session**, which was deferred once and then done.
  The SPA case forced it: `document.referrer` doesn't change on a route
  change (see "Client script embedding contract"), so a visitor who
  arrived from Google and clicked through five routes carried the
  Google referrer on all five page views — and unlike ordinary
  navigation those aren't self-referrals, so the exclusion above cannot
  catch them. The multiplier was how engaged the visit was, which is
  the opposite of what a source ranking is for: a traffic source is a
  way *in*, and a visit arrives through exactly one of them. Each
  session is now attributed once, to the referrer of the page view that
  started it (`MIN(ts)` with bare columns, the same trick
  `getEntryPages` uses), and the result field is `sessions` rather than
  `views` so the unit is impossible to misread.

  On an ordinary multi-page site this changes almost nothing — the
  self-referral exclusion was already removing the same rows — which is
  why the first fix looked sufficient. It is the SPA that separates the
  two, and an SPA cannot be detected from the data.

  The self-referral exclusion stays, because session-scoping does not
  subsume it: a session ends after 30 minutes idle, so a visitor who
  pauses and carries on starts a session whose *entry* page view
  carries the site's own previous page. That is one visit continuing,
  not a new source, so it is dropped rather than counted as direct.
- `get_top_events(period, limit)` (`lib/events.ts`'s `getTopEvents`) —
  every event type ranked by count, not just `page_view`. A general
  "what's actually happening" overview, distinct from `get_top_pages`
  which stays page-view-specific.
- `get_by_property(event, property, period, limit)` (`lib/events.ts`'s
  `getByProperty`) — one event type's occurrences grouped by one of its
  own declared prop values (e.g. `product_added_to_cart` grouped by
  `product_id`), via SQLite's `json_extract` against the `props` column.
  This is the generic dimension-breakdown tool: it doesn't hardcode
  which prop matters, so it works for any registered event/prop pair a
  deployment happens to define. Both `event` and `property` are
  validated against the schema registry before querying — an unknown
  event type or a prop that event doesn't declare returns a helpful
  error listing the valid options, same reasoning as `get_steps_funnel`
  above: a typo should look like a typo, not like an empty result.
- `get_property_sum(event, property, period)` (`lib/events.ts`'s
  `getPropertySum`) — the `SUM`/`AVG` counterpart to `get_by_property`:
  instead of grouping occurrences by a prop's distinct values, aggregates
  the prop's own numeric value across every occurrence (e.g. total and
  average revenue from an `order_completed` event's `value` prop).
  Answers "what's our revenue" without this project ever needing to know
  what a deployment calls its purchase event or its value prop — same
  registry-driven genericity as `get_by_property`, plus one more check:
  the declared prop must actually be numeric (checked via the registry's
  declared type, since `get_by_property` already proved a string/boolean
  prop is a valid thing to declare, just not a summable one) — a clear
  error otherwise, pointing at `get_by_property` for non-numeric
  breakdowns. This is also *why* a prop may not be a nested object (see
  "Schema registry" above): both this and `get_by_property` aggregate a
  single `json_extract($.key)` value, which can't reach inside one. An
  array is the case that turned out to be solvable, via `json_each` —
  see "Event schemas as JSON files". A revenue prop summed here is only as
  trustworthy as the events feeding it are non-duplicate — see
  `idempotencyKey` in "Data model" for the double-fired-confirmation-page
  case this doesn't otherwise guard against on its own.
- `get_segment_summary(event, property?, value?, period)`
  (`lib/segment.ts`'s `getSegmentSummary`) — traffic (sessions,
  interactionEvents, viewEvents) scoped to only the sessions that
  included a given event,
  optionally narrowed further to one specific prop value on that event
  (e.g. "sessions where `product_added_to_cart` happened with
  `product_id = \"abc123\"`"). `property` and `value` must be given
  together — one without the other is rejected with a helpful error,
  same as an unknown event/prop name.

  **Deliberately a single condition, not composable.** There's no
  AND/OR between multiple events or multiple prop conditions — that's
  not an oversight, it's the same line `get_by_property`/
  `get_steps_funnel` already draw: the moment a "filter" tool accepts
  boolean combinations of conditions, it's a query language, which is
  exactly what "Do NOT expose raw SQL or a generic `query_events(sql)`
  tool" above exists to prevent. If a real question ever needs
  multi-condition segmentation, that's a new, explicit design
  conversation — not a natural extension of this tool's `property`/
  `value` params.

Two more tools close a gap that's less about pages/events and more
about *who* is visiting — the kind of question every competing
analytics tool answers (GA4, Adobe Analytics, and the lightweight
privacy-focused ones this project is actually closer to, Plausible/
Fathom) that this project had nothing for until now:

- `get_device_breakdown(period, limit)` (`lib/audience.ts`'s
  `getDeviceBreakdown`) — traffic grouped by browser and device type
  (mobile/tablet/desktop/other), derived at query time from the
  `user_agent` column already stored on every event (`lib/userAgent.ts`'s
  `classifyUserAgent`) — no new column, no client change. _(Since
  reversed: the raw column is gone and the classification is stored
  instead — see "Device class instead of the User-Agent string" under
  Data model.)_ Same
  "SQL groups the raw values, JS re-aggregates the small distinct set"
  pattern as `get_top_pages`/`get_top_referrers`: classification runs
  once per distinct `user_agent` string in the period, not once per row.
  Query-time, not write-time, for the same reason as `parseUrl`: User-
  Agent string formats drift as browsers change them (arguably faster
  than URLs do — see e.g. Chrome's ongoing "UA reduction" effort), so a
  future fix to the classifier applies to all historical data instantly
  instead of needing a backfill migration. `deviceType` is `"other"`,
  never silently `"desktop"`, for anything that doesn't match a known
  mobile/tablet/desktop signature (a smart TV, game console, e-reader)
  — same "a mistake should look like a mistake" reasoning as
  `get_top_referrers`' explicit `null`-for-direct bucket.
- `get_average_session_duration(period)` (`lib/traffic.ts`'s
  `getAverageSessionDuration`) — average `MAX(ts) - MIN(ts)` across
  every session in the period, in seconds. A single-event session
  ("bounce") counts as 0 seconds, not excluded. This one **can't** be
  computed at write time even in principle, unlike the two cases above:
  a session's duration isn't knowable until it's over (30 minutes of
  inactivity with no new event), so at the moment any individual event
  is inserted, its session's eventual duration doesn't exist yet to
  write down. Query-time is the only coherent option, not just the
  preferred one. Supported by a new index, `idx_events_session_ts`
  (`session_id, ts`), since nothing else indexes `session_id` and this
  `GROUP BY` needs it.

Three more close a related gap: `get_top_pages` counts every page
view regardless of where it fell in a session, which can't answer
"where do visitors start," "where do they leave," or "which pages
fail to hold anyone's attention" — standard questions every competing
tool (GA4, Adobe, and the lightweight ones this project is closer to,
Plausible/Fathom) answers, that this project had no way to answer
until now. All three reuse `idx_events_session_ts` above, and all
require a `pageView`-tagged event, same gating and error message as
`get_top_pages`/`get_top_referrers`:

- `get_top_entry_pages(period, limit)` (`lib/content.ts`'s
  `getEntryPages`) — pages ranked by how many sessions' *first*
  page-view event landed there. Uses SQLite's documented behavior that
  a bare column (`url`) in a `MIN()`/`MAX()` aggregate query comes from
  the same row that produced the extreme value — no subquery or window
  function needed to get "the url at the earliest ts per session."
- `get_top_exit_pages(period, limit)` (`lib/content.ts`'s
  `getExitPages`) — same idea, `MAX(ts)` instead of `MIN(ts)`. Only
  meaningful in retrospect once a session is over, same reasoning as
  `get_average_session_duration` — necessarily query-time.
- `get_top_bounce_pages(period, limit)` (`lib/content.ts`'s
  `getBouncePages`) — pages ranked by bounce rate: of the sessions that
  entered on that page, what fraction viewed no other page. Returns
  `sessions` and `bounced` counts alongside the `bounceRate` (0-1), not
  just the rate alone — a 100% bounce rate from one session and a 100%
  bounce rate from a thousand sessions mean very different things, and
  hiding the raw counts behind a single ratio would make that
  impossible to tell apart, same "don't hide the numbers behind a
  potentially misleading metric" reasoning as `get_traffic_summary`'s
  zero-data note.

**The tool definitions are split across `server/mcp/`, by the kind of
question they answer** — `registry` (what this deployment tracks at
all), `traffic` (how much, and when), `content` (which pages, and where
from), `events` (what happened, in what order), `audience` (who is
visiting), `diagnostics` (is tracking working), `admin` (the one tool
that writes). `tools.ts` keeps only the wiring: `createMcpServer`, the
`registerTool` manifest wrapper, and the list of modules.

It had grown to ~900 lines with all 24 tools inlined in one function,
which made it the largest file in the project and buried that wiring in
the middle of it. Splitting it also surfaced how much was copy-paste:
the `limit` schema was written out identically twelve times, the
"no page-view event is tagged" guard seven times, and the MCP content
envelope (`{ content: [{ type: "text", text: JSON.stringify(x) }] }`)
at every single call site. Those are now `limitInput`, a shared guard,
and `jsonContent` in `mcp/shared.ts` — which is why the split removed
about 120 lines while *adding* two tools.

**`lib/metrics.ts` was split the same way, and the two now pair up.**
It had reached 872 lines and 25 exports — the leftover bucket for
everything that never earned its own file, after `funnel.ts`,
`segment.ts`, `rejectedEvents.ts` and `botActivity.ts` had each been
carved out of it. It's now `traffic.ts`, `content.ts`, `events.ts`,
`audience.ts` and `recentEvents.ts`, each sitting behind the `mcp/`
module of the same name, so "where's the query behind `mcp/content.ts`?"
has an obvious answer.

Two things fell out of it beyond size:

- **The `Period` type moved to `lib/period.ts`**, which already owned
  period *normalization* and had no imports of its own. Five modules
  (`funnel`, `segment`, `botActivity`, `rejectedEvents`, `audience`)
  were importing the whole metrics module purely for that one type.
- **`recentEvents.ts` is named for its concern, not for `mcp/`'s
  grouping.** `mcp/diagnostics.ts` draws on three lib modules
  (`recentEvents`, `rejectedEvents`, `botActivity`), so a
  `lib/diagnostics.ts` would have broken the fine-grained naming the
  rest of `lib/` already uses. The pairing is a convenience where it
  fits, not a rule to force.

The test file was split to match, and the total stayed at exactly 184
server tests before and after — the check that actually matters for a
move this size, since a silently dropped test file would still leave a
green suite.

Two of those close a gap found by auditing which stored columns nothing
ever read — `consent_mode` and `visitor_language` were being written on
every row and queried by nothing, the same shape of gap `referrer` had
before `get_top_referrers` existed:

- `get_top_languages(period, limit)` (`lib/audience.ts`'s
  `getTopLanguages`) — the visitor's own browser/device locale, parsed
  from `Accept-Language` at ingestion. Ranked by distinct visitors, not
  events, so one chatty visitor doesn't outrank a larger audience. A
  `null` language means no `Accept-Language` header at all, same
  explicit-null convention as `get_top_referrers`' direct bucket. Note
  this is distinct from an event's `document_language` prop, which is
  the *page's* declared language — different question.
- `get_consent_breakdown(period)` (`lib/audience.ts`'s
  `getConsentBreakdown`) — events and distinct visitors per consent
  mode. This is not curiosity: `get_new_vs_returning_visitors` is only
  meaningful for consentful visitors (consentless ids rotate daily), and
  its own description told agents to treat it as a soft signal without
  giving them any way to find out how soft. Now it can point at this
  tool. Event counts are exact; visitor counts can overlap, because a
  visitor who accepts a banner mid-period genuinely appears under both
  modes — the description says so rather than quietly double-counting.
  Exactly two buckets, always: `consent_mode` is `NOT NULL`, so there is
  no "unknown" third state to report (see "Data model").

Both live in `lib/audience.ts`. At the time that was to avoid growing
`lib/metrics.ts`, then the largest module in the project; it has since
been split along the same lines, so `audience.ts` turned out to be the
first file of that structure rather than an exception to it.

`getEntryPages`/`getExitPages` share a small JS-side "sessions per
path" aggregator, but deliberately don't share their SQL via a
dynamic `MIN`/`MAX` keyword parameter — two near-identical queries
were judged clearer and safer than building SQL text with an
interpolated aggregate-function name, even though the two possible
values are always internal, hardcoded literals, never user input.

That same call was made again for `lib/retention.ts`'s three
`pruneOld*` functions. They looked like obvious candidates to collapse
into one `pruneOlderThan(db, table, days)` — but the table name would
have to be interpolated into the SQL text, which is exactly what was
rejected above. What actually got deduplicated is the part that could
silently diverge: the cutoff-date arithmetic, previously written out
three times, is now one `retentionCutoff` helper. The three one-line
`DELETE` statements stay written out per table, which also keeps the
call sites naming what they prune instead of passing a table string.

**Queries filtering on an event type *and* a period are backed by
`idx_events_event_ts`** — every page-view-scoped metric
(`get_top_pages`, `get_top_referrers`, entry/exit/bounce pages, the
`viewEvents` half of every traffic summary), plus `get_by_property`
and `get_property_sum`. Only `ts` was indexed before, so those all
scanned the period's whole row range and filtered `event` row by row.
Ordered `(event, ts)`, not `(ts, event)`: equality-then-range is the
order SQLite can actually seek on, narrowing to one event type first
and then walking only that type's slice of the period — confirmed via
`EXPLAIN QUERY PLAN`, where it's even a *covering* index for the
count-only queries. Added while the table is small on purpose: an
index added later has to be built over every row that already exists,
and the moment it starts mattering is exactly when that hurts most.

A question came up while building these: should `get_top_entry_pages`/
`get_top_exit_pages` fall back to grouping by *any* event, not just the
page-view one? Considered and rejected in favor of two separate tools
instead:

- `get_top_entry_events(period, limit)` / `get_top_exit_events(period,
  limit)` (`lib/events.ts`'s `getEntryEvents`/`getExitEvents`) — rank
  by event **type**, not page, using the same bare-column
  `MIN`/`MAX(ts)` trick as `getEntryPages`/`getExitPages`, but grouping
  on `event` instead of `url`. Not gated behind a `pageView`-tagged
  event at all — there's no "page" concept involved, just event names,
  so these work for every deployment regardless of whether page views
  are tracked.

The reason this is two tools rather than one tool with a fallback: a
page-based answer (`{path, sessions}`) and an event-type-based answer
(`{event, sessions}`) are genuinely different shapes answering
different questions, not the same question computed two ways. Falling
back silently would also break down for a deployment that tracks *both*
page views and lots of custom events but whose `url` barely varies
(e.g. a single-page app that never updates the address bar) — grouping
by path would be meaningless there even though a `pageView`-tagged
event technically exists, so "is a page-view event tagged?" isn't
actually the right question to gate this decision on anyway. Unlike
`get_traffic_summary`'s `events`→`interactionEvents`/`viewEvents` split
(one field literally double-counted another), there's no shared field
here that would overlap or contradict between the two — they're just
two different, equally valid lenses on the same "what starts/ends a
session" question, so both are offered rather than picking one.

One tool beyond that illustrative set is implemented:
`delete_visitor_data(visitor_id, confirm)` (GDPR right-to-erasure, see
"Data lifecycle" below). Called without `confirm: true` it deletes
nothing — it only reports how many events would be deleted, so the
agent can surface that count and get the user's explicit agreement
before calling it again with `confirm: true`. This two-step shape is
the pattern for any future destructive tool: MCP tools are one-shot
request/response calls, so there's no interactive "are you sure?"
dialog at the protocol level — the confirmation has to be a second,
explicit call.

The schema registry (as an MCP resource) tells the agent what the data
means. The tool layer tells it what questions are answerable. Both are
needed — don't let the agent improvise queries outside these tools.
The `mcp/` modules call the `lib/` query functions directly (same process,
no network call). The MCP route itself is protected by `MCP_API_KEY`,
checked as an `Authorization: Bearer` header — reject requests without
it before invoking any tool.

The transport runs in **stateless mode** (`sessionIdGenerator: undefined`,
a fresh `McpServer` + `StreamableHTTPServerTransport` per request, per
the SDK's own recommended pattern for "simple API-style servers") rather
than tracking sessions — these are simple one-shot query tools, nothing
long-running or streaming that would need session/connection state.

**The cockpit also shows a tool overview** (name + description for
every registered tool), so a deployment that adds its own custom tool
to `mcp/tools.ts` sees it listed there too, without a second hand-
maintained list that could drift from what's actually registered. The
MCP SDK's `McpServer` doesn't expose a public way to list what's been
registered on it (only private internal fields), and the real
`tools/list` protocol method needs a connected transport — overkill for
an internal same-process read. Instead, `createMcpServer` wraps
`server.registerTool` once, right before any of the 26 actual calls to
it, so each one (completely unchanged) is recorded into a manifest as a
side effect of running; `getToolManifest(db)` exposes that list to
`routes/cockpit.ts`. TypeScript can't carry the specific overload
through a reassignment like this, so the cast there is a deliberate,
narrow escape hatch — same "correct by construction, not provable by
the type system" spirit as `defineEvent`'s own generic-inference casts.

**The tools are tested through the real protocol**
(`mcp/tools.test.ts`), using the SDK's own `InMemoryTransport`
linked-pair — no HTTP, no subprocess, nothing mocked, no new dependency.
That matters because most of what this layer does happens *around* the
handler: input-schema validation, the Zod period transform, and the
`registerTool` wrapper that adds both the manifest entry and the
inverted-period guard. Calling a handler directly would skip all three.
The whole harness is about a dozen lines and a full run is well under a
second.

These deliberately don't re-assert metric maths — `lib/` already covers
that. They cover the tool layer's own job: validation, gating, and the
shape promised to the agent. Two properties are worth keeping:

- **The cross-cutting tests are generated from `listTools()`**, not from
  a hand-kept list, so a new period-taking tool is covered the day it's
  written — the same reasoning the guard itself uses to find them. A
  fixture map supplies the non-period arguments some tools require, and
  a companion test asserts that map covers every period tool's
  `required` fields, so a new required argument can't make a generated
  test pass for the wrong reason (it caught exactly that on its first
  run).
- **The bare-date test is the important regression.** A bare
  `to: "2026-01-01"` sorts below every real timestamp that day, so
  before normalization the entire day silently vanished. Verified by
  mutation: disabling the end-of-day expansion turns it red, as does
  removing the inverted-period guard.

What this still can't catch is a *wrong description*. An agent misled by
inaccurate prose is this project's most plausible failure mode, and no
test sees it — that stays a human review job.

### A session belongs to the period it started in

An audit of the tools against the "sessions or events?" rule found
that every query looking at a session's *shape* — entry and exit pages,
entry and exit events, bounce pages, referrers, session duration — was
answering for the wrong sessions. Each took every event with a `ts`
inside the period and grouped by `session_id`, so a session already
under way at `from` had its first in-window event reported as its
entry page, a session with three views before `from` and one after was
reported as a bounce, and durations were clipped to the window. The
referrer tool's description even claimed such sessions were "left
out"; they were, but only because their first in-window view happened
to carry the site's own previous page as referrer, which the
self-referral rule then dropped — on a single-page app, where
`document.referrer` never changes, they were attributed twice. The
error grows as the period shrinks: on an hour-long window most
sessions straddle an edge.

`lib/sessionScope.ts` now holds one subquery, `SESSIONS_STARTED_IN_PERIOD`:
sessions with an event in the window (from the `ts` index) whose
`MIN(ts)` (an index lookup on `session_id, ts`) is at or after `from`.
The seven queries scope on it and then read each session in full —
including events after `to`, which is where a session that started
late in the period genuinely exited. The volume queries deliberately
do **not** change: `get_traffic_summary` and the per-day/hour/weekday
breakdowns count sessions *active* in the period, because "how many
sessions touched Tuesday" is what they answer; their descriptions now
all say a straddling session counts on both sides, where before only
the daily one did. The consequence the descriptions also state: an
entry-page total can be lower than the summary's session count for the
same period, and that is correct rather than a discrepancy.

Three smaller findings from the same audit landed with it:

- **`get_steps_funnel` is session-scoped by default.** It was keyed on
  `visitor_id`, and only its source comment admitted that a consentless
  id rotates at UTC midnight — so a visitor who viewed at 23:50 and
  bought at 00:10 was two people who each did half the funnel, and a
  funnel spanning days only ever counted consentful visitors. Since
  consentless is the default mode, the default scope is now the one
  that is correct for every visitor; `scope: "visitor"` is the opt-in
  for consentful deployments and multi-visit questions, and the
  description says what each loses. The result names its unit
  (`sessions` or `visitors`) per the naming rule, and `conversionRate`
  is rounded to four places like `bounceRate` — the agent was reading
  back `0.33333333333333331`.
- **`get_top_languages` counts sessions**, not distinct visitors. Under
  the daily rotation one German reader over a month was thirty
  "visitors", while `get_device_breakdown` beside it counted sessions.
  One unit across the audience family, and the one that survives the
  rotation. The `events` column it also returned — engagement inside a
  reach answer, and undocumented — is gone.
- **`get_segment_summary` checks the value's type** against the prop's
  declaration. `json_extract` compares `"5"` and `5` as unequal, so a
  value of the wrong type matched nothing and came back as zero
  sessions — "no data" for "wrong argument", the failure the invariants
  exist to prevent.

`get_average_session_duration`'s `sessionCount` became `sessions`, the
name every other tool uses for that unit.

### Ranked tools say what they were cut from

The same audit graded return shapes. Every `get_top_*` tool returned a
bare top-N array, which told the agent nothing about what it was cut
from — ten pages, or ten of four hundred? — and gave it no denominator:
a share needed a second call whose unit might not even match
(`get_top_pages` counts views, `get_traffic_summary` counts sessions
and events). Question 0 of the audit was "why is `limit` capped at 100,
and where is the next page?" The answer is that pagination is the
wrong fix: it invites an agent to pull a whole table through a layer
designed to answer one question at a time. The right fix is making the
cut visible.

Every ranked query now returns `Ranked<T>` from `lib/aggregate.ts`:
`{ items, groups, total }`, where `groups` is how many distinct rows
there were before the limit (so `groups > items.length` means the list
was cut) and `total` is the ranked unit summed across all of them (so
`row / total` is a share in the same unit, no second call). `rank()` is
the one place that sorts, slices and sums; the queries that used to
`ORDER BY … LIMIT` in SQL now hand it every group — the group counts
involved (event types, languages, distinct prop values, rejection
reasons) are small at this project's scale. `rankedShape(unit)` in
`mcp/shared.ts` is the one sentence every ranked description ends with.
The cockpit route takes `.items` and its JSON is unchanged.

With it, the shape and naming findings from the same audit:

- **`get_daily_traffic` is `get_traffic_by_day`**, matching its
  siblings `get_traffic_by_day_of_week` and `get_traffic_by_hour` and
  the `getTrafficByDay` it always called. **`get_by_property` is
  `get_events_by_property`**: every other name says what it returns,
  and this one had no noun. No `_by_sessions`/`_by_count` suffixes were
  added anywhere — the audit asked whether a name should carry its
  unit, and the answer is that the *field* should: `get_top_events` and
  `get_top_entry_events` were confusing only because one returned
  `sessions` and the other a bare `count`.
- **No bare `count` anywhere.** `get_top_events`,
  `get_events_by_property` and `get_orphaned_events` return `events`;
  `get_top_rejected_events` and `get_bot_activity` return `requests`;
  `get_property_sum` returns `values` — the number that went into the
  sum, which is what its description had to explain `count` meant. (In
  SQL that alias is `value_count`, because `VALUES` is a keyword.)
- **`toolError` sets `isError: true`.** Every error path goes through
  it, and the protocol has a flag for exactly this; without it a client
  shows a refusal as an ordinary result, and a model reading a
  transcript can't tell it from data.
- **`get_top_bounce_pages` ranks by bounced sessions**, ties broken by
  rate. Sorted on the rate, a page with one session and one bounce sat
  above one with 500 sessions and 400 bounces, and the description had
  to warn about it instead of the ranking meaning something.
- **`get_recent_events` carries `sessionId`, `consentMode`,
  `referrer`, `deviceType` and `browser`.** "Are these two hits one
  visit" and "did the consent banner switch modes" are the questions a
  site owner asks while installing the script, and the spot-check tool
  couldn't answer them. `visitor_id` stays out: `delete_visitor_data`
  treats an id read from a tool result as untrusted, and not returning
  one is the simplest way to keep that true.
- **`get_top_pages` says it groups by path and drops the host.** A
  deployment serving two domains sees both `/pricing` pages merged. The
  referrer tool already handles several domains per row; this one is
  documented rather than changed until a real multi-domain deployment
  turns up.

### Segments: one argument instead of one tool per question

The audit's coverage grading asked whether the tools, in combination,
could answer "where did the buyers of item X come from" — and they
could not. `get_segment_summary` could select those sessions but only
returned three totals; `get_top_referrers` could rank hosts but took no
filter. The join between "bought X" and "arrived from" lives inside a
session, and only the server can see it. The same wall stood in front
of "what do mobile visitors read", "revenue from Google traffic" and
"how did the newsletter campaign do".

A tool per combination was never going to scale, and a raw-row export
was ruled out by the user (it breaks the no-raw-SQL invariant in
spirit, sends visitor ids off the server, and makes the model do set
arithmetic over thousands of rows). What scales is the mechanism
`get_segment_summary` already had, generalised: **every period-taking
tool takes an optional `segment`**, a list of conditions all of which
must hold, and answers for those sessions only. `lib/segment.ts`
builds a `SegmentClause` — one ` AND session_id IN (...)` fragment per
condition, bound parameters only — that every query pastes after its
period condition, exactly the way `periodInput` is spread into every
schema. `get_segment_summary` itself is gone: it was `get_traffic_summary`
with a segment.

Seven kinds of condition, one dimension each, no OR: an event
(optionally with a prop value; "contains" for a list prop), device
type, browser, language (a bare "en" matches "en-US"; null is no
header), entry referrer host (null is direct), entry path, and one
entry-page query parameter such as `utm_campaign`. The entry-based
three are resolved in JS from the same rows `getEntryPages` ranks — a
host or a parameter is parsed out of the stored URL at query time, per
"Data model" — and handed to SQL as a JSON array through `json_each`.
Validation lives in `mcp/shared.ts`'s `resolveSegment`, so a typo'd
event, an undeclared prop, a wrongly typed value or a query parameter
that ingestion strips all come back as an error naming the valid
options, never as a segment that silently matches nothing. The
parameter allowlist in `lib/url.ts` gained a read side for that.

The rest of the coverage list landed with it:

- **`visitors`** (distinct ids) on the traffic summary and every
  bucketed breakdown. The first number anyone asks for, and it was only
  reachable as a side effect of the consent and new-vs-returning
  splits. The daily rotation of consentless ids is disclosed in the
  description, as Plausible does, rather than the number withheld.
- **`get_event_trend(event)`**: one event per day, zero-filled, with
  sessions and visitors. Not an option on `get_traffic_by_day`: a
  single event's shape is `events`, not an `interactionEvents` /
  `viewEvents` split with one side always zero. Shares the trend cap,
  which moved to `mcp/shared.ts` for the purpose.
- **`get_session_summary`** replaces `get_average_session_duration`:
  sessions started in the period, read in full, with duration and the
  site-wide bounce rate (`bounced / sessionsWithViews`). The rate lived
  nowhere before, and summing `get_top_bounce_pages`' top rows gave a
  wrong total the moment a page fell off the list. A session with no
  page view at all is in `sessions` but not in the bounce denominator:
  it never entered on a page, so it can't have bounced off one.
- **`get_top_entry_params(param)`**: sessions ranked by one entry-page
  query parameter — the read side of keeping `utm_*` and click ids at
  ingestion, which nothing read before. Still no attribution model;
  the caller names one parameter, and combining two is two calls.
- **`get_device_breakdown` returns `{ deviceTypes, browsers }`**, two
  rankings, instead of the browser × device cross the cockpit had
  already stopped using for the reason recorded above (Chrome alone
  took three of six rows). Browser on one device is a segment.
- **`get_schema_errors`**: the event files the loader rejected, which
  the cockpit showed and no tool did — so an agent asked "why does my
  event record nothing" had no way to see the actual cause.
- **`get_cohort_return`**: did one period's visitors come back in a
  later one. A set intersection across periods, not composable from
  counts. It is only half answerable by design: a consentless id is a
  new hash every day, so the result reports `consentfulVisitors` and
  the description tells the agent to say "of the N identifiable
  visitors, M came back; K were consentless and cannot be followed"
  rather than reporting a return rate that is really a consent rate.
  The two periods are separate arguments (`cohortFrom`/`cohortTo`,
  `returnFrom`/`returnTo`), so the registration-time inverted-period
  guard doesn't see them; the handler checks both, and that the return
  period starts after the cohort ends.

**What the reviews of the segment builder changed.** The
testing-specialist and security-expert passes over the commit above
found no injectable path (every caller value is a bound parameter; the
one interpolated column name comes from a two-value lookup on a typed
enum), no identifying value in any new result, and the following, all
fixed with tests:

- An event condition was bounded by the period, while the
  session-shaped queries read a session that started in the period in
  full — so "sessions that started yesterday and ordered" lost exactly
  the midnight-straddling order `lib/sessionScope.ts` was written to
  keep. The event is now matched anywhere in a session that touches
  the period.
- A segment on the unclassified device or browser (`other`/`Other`)
  compared the column to that literal and missed the NULL rows the
  breakdown folds into the same bucket, so the segment under-counted
  what the breakdown had just reported.
- Five shapes passed validation and could only match nothing — a URL
  where a host was asked for, a path without its slash or with a query
  string, an empty or wildcard "language", and two conditions on a
  dimension a session has exactly one of (`[{deviceType: "mobile"},
  {deviceType: "tablet"}]`, the obvious way to write an OR this has
  never offered). Each is now an error naming the expected form.
- The language match used `LIKE`, so `%` and `_` in the value were
  wildcards and the bare-value half was case-sensitive while the
  variant half was not; it is now a lowercased exact-or-prefix
  comparison on `substr()`, and the value must be a locale tag.
- The entry-page query parameter was matched by exact name while the
  allowlist that keeps it at ingestion is case-insensitive, so a link
  tagged `UTM_Campaign` answered to nothing; matched case-insensitively
  now, in the segment and in `get_top_entry_params` alike.
- The entry page views of the period were loaded once per entry-based
  condition; loaded once per call now. No period cap on top of that:
  it is the same materialisation `get_top_referrers` has always done
  for the same period.
- `get_cohort_return`'s description claimed only consentful cohort
  visitors could return. Consent freezes the consentless hash into the
  cookie, so a visitor consentless in the cohort who consents later
  keeps that day's id and does return; `consentfulVisitors` is a floor,
  and the description says so.
- Adjacent and pre-existing: `visitor_language` was the one envelope
  field with no cap — the first Accept-Language token stored verbatim,
  bounded only by Node's header limit — while the raw User-Agent is
  dropped for exactly the singling-out reason, and `get_top_languages`
  read it back without the visitor-text caveat. Only a locale-shaped
  token is stored now (anything else is treated as no header), the
  caveat is on the tool, and both it and `get_top_entry_params` are in
  the test's list of tools returning visitor-written text.

One observation recorded rather than acted on: a segment on
`entryParam: "gclid"` with one click id narrows `get_cohort_return` to
a single person's return behaviour. That is the owner querying their
own already-stored data (the id is already exposed by
`get_top_entry_params`), so it is no new exposure — but it is the first
tool that answers a per-individual question by construction.

## Release reviews

Two full reviews of the codebase were run on 2026-09-12, before v0.2.
What they changed is in the code and the git history; what they
**deliberately did not change** is the part worth keeping, because
without it the next reviewer finds the same items again:

- **Comment pruning** — conflicts with the comment rule in `AGENTS.md`.
- **Collapsing the bucketed SQL** into one function taking the
  `strftime()` expression — working, tested, and the project avoids SQL
  built from variables.
- **Minifying the client** — 16.5 KB raw is 6.2 KB gzipped, fetched
  once per session; a build-time dependency doesn't clear the bar.
- **Removing the bot-activity table** — it is where rate-limit and
  crawler visibility belongs.
- **Sending the beacon as `text/plain`** to skip the CORS preflight —
  changes the ingest contract to save one round trip a day per visitor;
  the preflight is cached for a day instead.
- **Dropping the event-rename machinery** — the role tags exist only so
  a deployment can rename a built-in event, and nobody has; but it is
  built, tested and documented, so removing it costs more than leaving
  it. Don't extend it.
- **A rate-limit count in the cockpit** — deferred, not refused: logs
  answer "is this happening"; a `reason` column on `bot_activity` would
  go beside the bot and rejected counters.
- **Enforcing the auto-fired events' prop shapes at import** — the
  client hardcodes the props it sends, so a reshaped event is rejected
  as `invalid_props` with the offending key in `lastDetail`, which the
  recipe already points at.

One reversal from those reviews is worth naming because the first
round refused it: `defer` on the embed. Round one called it "trades
collection for page speed, wrong direction here", treating the two as
symmetric. They aren't: the blocking round trip is paid by every
visitor on every page load, while a deferred script still runs before
`DOMContentLoaded`, so what is given up is only the visitor who leaves
before the HTML finished parsing. Verified that `document.currentScript`
still resolves the endpoint under `defer` by loading the compiled
client from a real HTTP server in jsdom, both ways.

## The agent reads attacker-controlled text

Worth stating as its own concern, because it is specific to an
AI-native design and nothing else in this file covers it.

`POST /events` is public and unauthenticated — it has to be, it's a
tracking snippet. Several tools then hand what it stored to the agent
word for word: `get_recent_events` returns raw `url` and `props`,
`get_top_rejected_events` returns `lastDetail`, `get_by_property`
returns prop values as group labels. So text a stranger typed reaches
the model's context whenever the site owner asks a question, and the
MCP server has a tool that permanently deletes event data.

Three things narrow it, none of which closes it:

- **Length.** `defineEvent` refuses a string prop that accepts more
  than `MAX_PROP_STRING_LENGTH`, and the rejection path truncates the
  event name and the Zod detail it stores. Before this, `page_title`
  was a bare `z.string()` and a single request could plant ~15KB of
  prose; now the budget for one field is 512. This does not prevent
  injection — it removes the room to write at length, which is most of
  what a convincing instruction block needs.
- **Labelling.** The three tools carrying visitor strings say so in
  their descriptions: data to report on, never instructions to follow.
  A description is the only documentation an agent gets, so it is also
  the only place to put this.
- **The destructive tool names its own precondition.**
  `delete_visitor_data` states that a `visitor_id` must come from the
  person asking and never from another tool's output, which is exactly
  the step an injected instruction would need.

What is deliberately *not* attempted: filtering or sanitising the text
itself. There is no reliable way to detect "this sentence is an
instruction", and a filter that half-works would make the guarantee
sound stronger than it is. The honest position is that the agent reads
untrusted input, the deployment should know that, and the blast radius
is one write tool with a stated precondition.

**Tool results also leave the deployment.** The storage is
self-hosted, but the MCP client is not: whatever a tool returns enters
that model's context, which for a hosted assistant means it reaches
the vendor's API. Asking a question is therefore the one routine
action that moves data off the box, and for a client deployment in the
EU that is a processor relationship with its own agreement and
transfer basis. Documented in the README under "What leaves your
server when you ask", since it is the deployer's decision, not
something the code can settle. `get_recent_events` is the only tool
returning raw rows, so it is the one a cautious deployment can
unregister.

## Dependency philosophy

Minimize third-party dependencies. Before adding any library, it must
pass both of these:

1. **Fully open source, no payment tier required for any functionality
   we use.** No "free tier with limits" SaaS dependencies, no libraries
   that push toward a paid hosted service.
2. **Very common OR clearly well-established** — either widely used with
   an active community, or (if newer/smaller) the de facto reference
   implementation for what it does with no real alternative.

When a choice is borderline, say so explicitly and ask rather than
picking silently. Prefer the Node/browser standard library over a
dependency when it reasonably covers the need. When a dependency can be
avoided entirely by writing a small amount of plain code (e.g. raw SQL
instead of an ORM), prefer avoiding it, unless that meaningfully hurts
type-safety or readability.

**Current stack, audited against this:**
- Express — OSS/MIT, the most established Node web framework, largest
  community; chosen over Hono for being the more basic, less novel option.
- better-sqlite3 — OSS/MIT, synchronous, long-established SQLite driver.
- `node:test` — built into Node, zero added dependency, sufficient for
  this project's straightforward unit tests.
- Zod — OSS/MIT, de facto standard for TS validation.
- SQLite — public domain, as common as it gets.
- `@modelcontextprotocol/sdk` — OSS/MIT, reference implementation of the
  protocol itself, no real alternative.
- No ORM — raw SQL, one fewer dependency, more transparent for learning.

## Releasing a version

`docs/releasing.md` is the copy-paste version of this; the reasoning is
here.

Commit freely and tag when the state is worth naming — a tag is a label
applied afterwards, not something to plan around. Bump `patch` for a
fix, `minor` for a feature, `major` for a breaking change; while the
version starts with `0.`, breaking changes are expected, which is what
"Current status" at the top of this file is really saying.

Use `npm version` rather than editing `package.json` by hand:

```sh
npm version minor -m "Release %s"
git push --follow-tags
```

It bumps the root `package.json`, commits that change, and creates the
matching tag in one step — so the two numbers can't drift, because
neither is typed by hand. Only the root package carries a version: the
three workspaces are `private: true` and never published to npm, so
versioning them would be four numbers to keep in sync instead of one.

`--follow-tags` is the part worth remembering: a plain `git push` sends
commits only, and the tag would stay on the machine that made it.

Two rules that come with tags: `npm version` refuses to run on a dirty
tree (deliberately — it forces a clean, tested state), and a tag that
has already been pushed is never moved, since someone may already have
that version. Cut a new one instead.

## Coding conventions

- TypeScript, strict mode, no `any` unless justified with a comment.
- Prefer small, single-purpose modules over large files, even within
  the single `/server` process.
- Zod schemas are the source of truth for shapes — derive TS types from
  them (`z.infer`), don't hand-write parallel interfaces.
- Tests: `node:test` + `node:assert`.
- **Never wait a fixed number of milliseconds for something
  asynchronous.** Poll until the expected thing appears, and fail on a
  generous timeout. A fixed wait is a race, and it fails in two
  directions: the visible one is a flaky red, but the dangerous one is
  a test asserting that nothing happened *before the thing it's
  watching for could have happened at all* — which passes, forever,
  without testing anything. Both were live in this repo: jsdom
  dispatches `popstate` somewhere between 8ms and 31ms after
  `history.back()`, against a shared 20ms wait.

  Where an absence genuinely can't be polled for, the fixed wait stays,
  but the number clears the measured ceiling and is named and commented
  rather than left as a magic constant.

## v1 scope (build in this order)

1. `schema-registry`: envelope schema + 2-3 pre-defined event schemas.
2. `/server` — `routes/events.ts`: Express endpoint, validates against
   registry, derives `visitor_id`/`session_id` per the consent mode
   (cookie for consentful, salted hash for consentless), writes to
   SQLite via raw SQL.
3. `client`: minimal JS snippet, sends `page_view` + a generic
   `track(event, props)` method.
4. `/server` — the metrics layer: session stitching + basic aggregates
   (sessions, page views, top pages) over stored events. Built as one
   `lib/metrics.ts`; since split into `lib/traffic.ts`, `content.ts`,
   `events.ts`, `audience.ts` and `recentEvents.ts` (see "Repo
   structure").
5. `/server` — `mcp/tools.ts`: expose schema registry as a resource +
   2-3 tools (`get_traffic_summary`, `get_top_pages`, `list_event_types`),
   mounted on the same Express app via the MCP streamable HTTP transport.
6. `/apps/cockpit` + `/server` — `routes/cockpit.ts`: a small
   read-only JSON route reusing the `lib/` query modules + the schema
   registry,
   and a static HTML/JS page (no framework) previewing collected data
   and the schema registry against it.
7. `Dockerfile`: multi-stage, npm-workspace-aware build producing a
   small runtime image that runs `/server`. Plus a short deployment note
   covering the one thing that isn't just "set env vars" — `DB_PATH`
   must point at a path backed by a persistent volume (e.g. a Coolify
   persistent storage mount), or the SQLite file (and all collected
   data) is lost on every redeploy. TLS/reverse-proxy termination is the
   host platform's job (e.g. Coolify's Traefik) — the container only
   ever needs to listen on plain HTTP.

Do not start on anything beyond this list (funnels, custom event UI,
multi-tenancy, admin/write functionality) until this end-to-end slice
works.

## Explicitly out of scope for v1
- Multi-tenancy
- Postgres/ClickHouse
- Bot filtering / spam protection (note as a known gap, revisit later)
- Cockpit auth beyond a single shared password: `COCKPIT_PASSWORD`
  (HTTP Basic Auth, see "Configuration") covers "keep casual visitors
  out"; anything more (per-user accounts, roles) is out of scope — this
  is still a single-owner preview tool, not a customer-facing product.
- GDPR/consent tooling — i.e. an actual cookie-consent banner / consent-
  management UI on the tracked site. The consentless/consentful dual
  identification mode (see "Visitor identification") is a building
  block for this, not a substitute — real deployments still need their
  own consent UI wired to the `consent` field before going live, but
  that wiring is not a v1 blocker for the pipeline itself.

## Project maturity & path to a solid product

**Verdict, as of the v1 slice being complete:** the concept holds up —
"self-hosted analytics, queried via an AI agent instead of a dashboard"
is a real, differentiated niche, and shipping both a cockpit *and*
MCP hedges against the risk that natural-language querying alone isn't
enough for a quick glance. The privacy-conscious identification model
(consentless hash / consentful cookie, with a same-day merge on
consent) is more thought-through than most projects at this stage.

But maturity-wise, this is a **solid, tested MVP for one developer
running it for themselves — not yet a product to hand to a client and
walk away from.** The pipeline logic itself (identity, sessions,
metrics, schema validation) is well-tested and carefully handles real
edge cases (prototype-pollution guard, malformed-cookie handling,
timing-safe key comparison). What's missing is everything around it:
operational safety nets, data lifecycle management, and enough MCP
tools to make the core pitch land. None of this blocks continuing to
use/develop v1 as-is — it's what's needed before treating this as
something a client's business actually depends on.

Not a promised roadmap — same "flags an idea, not a commitment" caveat
as the illustrative MCP tools above. Don't start any of these until
there's a concrete need for them.

(Schema migrations — previously listed here as the top-priority item —
are done: see `db/migrations.ts`. `db/index.ts` calls `migrate(db)` on
every startup, running an ordered list of migration functions tracked
via SQLite's own `PRAGMA user_version`, so both a brand-new database
and an existing production one always converge on the same schema.
Adding a future column or table means appending one function to that
list — never editing or removing an already-shipped one.

That list is a single entry today. It had grown to eight, but seven of
those existed only to carry a pre-existing database forward to the
schema the eighth ended at — and under "Current status" at the top of
this file, no such database exists. They were collapsed into the one
schema they added up to, verified by diffing the resulting
`sqlite_master` against the old chain's: identical columns, order,
indexes and `auto_vacuum`, with the single deliberate change being
`consent_mode` becoming `NOT NULL`. The collapse was a one-off that
"Current status" made free; the append-only rule above resumes
immediately and binds from the first real deployment onward.)

### Operational safety

- ~~Backups~~ Partially done: `LOCAL_BACKUPS` (see "Configuration",
  default `true`) gives a daily local backup, kept for 7 days, via
  `lib/backup.ts`. This covers mistakes (bad migration, accidental
  deletion) but not losing the volume/disk itself, since the backup
  lives on the same volume as the live database. The off-host copy for
  that case is still the deployer's own job, but it is documented now
  rather than left as an exercise — see "Copying backups off the host"
  in the README.

  What that section recommends is copying the `backups` folder the
  daily job already writes, not running `sqlite3 .backup` against the
  live database as previously sketched here: those files are already
  finished snapshots, so the off-host job needs no SQLite tooling on
  the host and no coordination with the running server. It also
  documents the restore, including the step that silently goes wrong —
  dropping a restored database in beside the old `-wal` makes SQLite
  replay that log on top of it, resurrecting rows the backup never had,
  with `integrity_check` still reporting `ok`. Verified against a real
  WAL database, not assumed.
- ~~Health check endpoint~~ Done: `GET /healthz` (`server/index.ts`)
  checks the database is actually reachable, not just that the process
  is alive. The Dockerfile now declares a `HEALTHCHECK` against it, so a
  container that started but can't reach its volume reports unhealthy
  instead of quietly accepting traffic — previously the endpoint existed
  but nothing in the image pointed at it, leaving it up to whatever the
  host platform happened to be configured to do. It shells out to Node's
  own `fetch` rather than `curl`/`wget`, neither of which the runtime
  image contains.
- ~~CI~~ Done: `.github/workflows/ci.yml` runs the build, all three
  workspaces' test suites, lint, and `format:check` on every push/PR.
- ~~Startup/shutdown wiring coverage~~ Done:
  `server/integration/wiring.test.ts` — which background jobs
  `server/index.ts` actually starts, in what order, under which env-var
  combination, previously had zero automated coverage; everything under
  it (`lib/`, `db/`) is unit-tested, but the entrypoint itself had only
  ever been checked by hand. `index.ts` is side-effecting top-level code
  (routes mounted, jobs scheduled, `app.listen` called), not something
  with an exported function to call — rather than refactoring it into
  one purely to make it unit-testable (real risk to code that already
  works, for a project whose own style already leans toward integration-
  realism over mocking), these tests spawn the real compiled
  `dist/index.js` as a subprocess against a real temp SQLite file and
  observe it the same way a person checking it by hand would: does it
  fail fast on a bad `PORT`, does it log the structured "listening"
  line and answer `/healthz`, does `RETENTION_DAYS` actually prune an
  old row at startup (not just get scheduled), does `SIGTERM` produce a
  clean exit. Slower than this project's other (in-process) tests, and
  — unlike the `setInterval`-scheduled recurring runs — can only observe
  what happens at startup/shutdown, not a job firing again hours or a
  day later; accepted, since waiting a real day in a test isn't
  practical either way.
  **Discovered and fixed a real bug while adding this file:**
  `server/package.json`'s `test` script was `node --test dist/**/*.test.js`
  with the glob *unquoted* — npm runs scripts via `sh` (`dash` on this
  machine, no `**` recursion support), so the shell expanded it before
  Node ever saw it, silently matching only files exactly one directory
  level under `dist/` (`dist/lib/*.test.js`, `dist/db/*.test.js`) and
  never a file directly in `dist/` itself. This had no visible symptom
  until now, since every existing test file already happened to live
  one level deep. Fixed by quoting the glob so Node's own glob engine
  (which does support `**`, at any depth) handles it instead of the
  shell — verified directly against zero-, one-, and two-level-deep
  probe files.

  **The quotes have to be double, not single**, which the original fix
  got wrong in the other direction. npm runs a script through `sh` on
  POSIX but through `cmd.exe` on Windows, and `cmd` doesn't treat `'`
  as a quote character at all — so Node received the pattern with
  literal apostrophes around it, matched nothing, and reported
  `tests 0 / pass 0 / fail 0` with a zero exit code. The entire server
  suite was skipped silently on Windows, the same shape of invisible
  failure the original bug had. Double quotes are stripped by both
  shells, so Node sees the bare pattern either way.

  Running the suite on Windows for the first time then exposed a real
  bug in `integration/wiring.test.ts` that had been invisible on Linux.
  Each test registered two `t.after` hooks — remove the temp directory,
  then stop the server — and those run in registration order, so the
  directory was removed while the spawned server still held the SQLite
  file open. POSIX allows unlinking an open file, so nothing happened
  there; Windows refuses, and the `EPERM` skipped every remaining hook,
  leaving the server running and the whole run hanging on the orphan
  (one test took 178 seconds). Six of eight cases failed. Folding both
  into one hook that stops the server *first* fixed five of them and
  cut the file's runtime to about two seconds.

  The two that remain are genuinely platform-bound and now skip
  themselves on Windows: `chmod 0o500` is a no-op there, and
  `child.kill("SIGTERM")` maps to `TerminateProcess`, which kills the
  child outright rather than delivering a signal it could handle — so
  the graceful-shutdown path can't be observed at all. Skipped rather
  than weakened, since the behaviour matters everywhere this is
  actually deployed (Linux containers), and both still run on CI.
- ~~Builds leaving orphaned test output~~ Done: each workspace removes
  `dist` (and `tsconfig.tsbuildinfo`) before `tsc -b`, and `test` runs
  that clean build rather than a bare `tsc -b`. `tsc` never deletes an
  output whose source is gone, so `dist/lib/metrics.test.js` and
  `dist/lib/dashboardAuth.test.js` survived the `metrics.ts` split and
  the dashboard→cockpit rename and kept passing against equally stale
  modules — 17 of a reported 227 tests were exercising code that no
  longer existed, while CI's fresh checkout saw the real 210.

  `tsc -b --clean` does **not** fix this (verified): it only knows
  about outputs from current sources, which is exactly why these
  survived. Removing `tsconfig.tsbuildinfo` alongside `dist` is
  required, not belt-and-braces — `packages/*` keep theirs at the
  package root rather than inside `dist`, so deleting `dist` alone
  leaves `tsc` believing the project is up to date and emitting
  nothing at all.

  The cost is losing incremental compilation, which at nine seconds
  for all three workspaces is not worth defending against a failure
  that is silent, green, and grows with every future rename.
- ~~Rate limiting on `/events`~~ Done: `lib/rateLimit.ts`'s
  `rateLimitEvents`, a small in-memory per-IP fixed-window limiter (600
  events/minute/IP), no dependency added. Bot filtering (below) only
  catches crawlers that identify themselves honestly; this catches the
  other case — a runaway client-side loop or a basic scraper hammering
  the endpoint — regardless of what User-Agent it sends. In-memory and
  per-process only, which is fine given this is deliberately a single
  Express process (see "Repo structure"); not meant to stop a
  determined, distributed attacker, which is a job for a layer in
  front of this app (a CDN/WAF), not application code.
- ~~Brute-force protection on the authenticated routes~~ Done:
  `lib/rateLimit.ts`'s `createFailedAttemptLimiter`, used by both
  `lib/cockpitAuth.ts` and `routes/mcp.ts` (10 failures per IP per 15
  minutes). Only `/events` was rate limited before, leaving the two
  routes actually guarding data — each behind a single shared secret —
  freely guessable. `timingSafeStringEqual` stops timing attacks but
  does nothing against simply trying repeatedly.

  Counts **failed attempts**, not requests, which matters for the
  AI-first design: an agent working through a question legitimately
  fires many `/mcp` tool calls in a burst, and a per-request limiter
  would throttle exactly that while barely slowing an attacker who
  needs only one guess per window. A successful call consumes no
  budget at all.

  A blocked IP is refused *without its credentials being checked*,
  which necessarily locks out the real password too until the window
  lapses. That's the point — validating a blocked IP's guess anyway
  would let it keep guessing at full speed and the limit would protect
  nothing. The cost is that someone sharing an IP with an attacker (an
  office NAT) is locked out alongside them; acceptable for a
  single-owner tool where the fallback is waiting 15 minutes or
  restarting the process.

  2026-09-24: the two danger-zone confirmations had no limit at all.
  They sit behind a session, but a session cookie is not the password,
  so a stolen cookie could guess the password there at full speed. Now
  each wrong guess counts toward the same per-IP budget as sign-in.
  That alone does not stop the cookie holder, who can switch
  addresses. The session is the one thing they cannot switch, so five
  wrong confirmations in a row, from anywhere, sign every session out.
  Only a session reaches those boxes, so a stranger cannot use this to
  lock the owner out.
- ~~A request limit on `/mcp`~~ Done, 2026-09-15: `createRequestLimiter`
  in `lib/rateLimit.ts` is the `/events` limiter made into a factory,
  and `/mcp` mounts one at 60 calls a minute per address, ahead of the
  key check. The entry above argued against exactly this — that a
  per-request limit throttles the agent's burst — and that argument
  still decides what protects the *key*: failures, not requests. What
  changed is the threat. A key that is public (the demo, below) is not
  guessed, it is used, and the entry-based segment conditions
  materialise every entry row of their period per call, so one loop on
  a known key is a way to keep the server busy indefinitely. Sixty a
  minute is an order of magnitude above an agent's real cadence (a
  question is a handful of calls, list_event_types included) while a
  tight loop meets it in a second. A tenth of `/events`'s ceiling
  because the two addresses are not alike: one on `/events` can be an
  office, one on `/mcp` is one agent. Mounted before the key check so
  a flood is bounded whether or not it knows the key, and so that a
  flood without the key does not turn into ten failures and a lockout
  on the failed-attempt limiter — those two now compose in the right
  order. Same one-line-per-window log as `/events`, with a `route`
  field to tell them apart.

  A per-request limit is only a limit if a request is one call. The
  transport accepts an **array** of JSON-RPC messages in one POST, and
  Express's default body limit is 100kb, so a `tools/call` of ~150
  bytes meant one allowed request could carry hundreds of them — sixty
  a minute would have bounded tens of thousands of queries a minute,
  which is to say nothing at all. `routes/mcp.ts` now refuses an array
  body with `-32600` and parses at 16kb. Batching left the MCP spec in
  2025-06-18, so this costs no client anything. Refused before the
  transport sees it, because the point is to answer before any query
  runs. The wiring test asserts the order too — a wrong key inside a
  spent window must be answered 429 by the limiter, not 401 by the key
  check — since every assertion about the ceiling alone passes just as
  well with the two mounted the wrong way round.
- ~~Every counter keyed on the full address~~ Fixed, 2026-09-15. The
  three controls that bound abuse — the `/events` and `/mcp` request
  limits, the `/mcp` key lockout and the cockpit password lockout —
  all keyed on `req.ip`, and the comment in `identity.ts` defended it:
  narrowing is for the hash, the limiter needs the whole address,
  because throttling a /24 throttles an office for one abuser.

  That reasoning is right for IPv4 and backwards for IPv6. Addresses
  are scarce in one family and free in the other: a residential line is
  *delegated* a /56 or a /48 and can send from any address inside it,
  so keying on the full address gave one attacker a fresh budget per
  request for the asking. The visible half was the request limits. The
  half that mattered was the lockouts — ten guesses per fifteen minutes
  is the only thing between a guesser and `COCKPIT_PASSWORD` or
  `MCP_API_KEY`, both single shared secrets, at a hostname the
  deployment model makes entirely predictable. On IPv6 that limit
  bounded nothing.

  `limiterKey` (`lib/ip.ts`, new — the address parsing moved there out
  of `identity.ts`, which is about identity and had grown a second
  concern) keeps IPv4 whole and narrows IPv6 to a /48. Not /64, which
  is the usual choice and is wrong here: a /64 is one LAN and a line
  holds many, so an attacker rotates across them exactly as before. A
  /48 is the largest common end-site delegation, so no line spans more
  than one.

  That deliberately takes the over-grouping error rather than the
  under-grouping one, and the cost is not nothing: plenty of providers,
  German residential among them, delegate a /56, so one /48 can hold a
  couple of hundred unrelated households sharing a budget. For the
  lockouts that is close to free — the collateral is a fifteen-minute
  wait, landing only on someone who is themselves failing auth, and
  there is exactly one legitimate operator and one agent. For `/events`
  it is the real cost, since a refusal there is silent, permanent data
  loss. The knob for that is the ceiling, not the key width: narrowing
  less hands the bypass straight back.

  The key is also canonicalised, which narrowing alone does not do: one
  address has several legal spellings (case, leading zeros, the mapped
  and plain forms of an IPv4 address), and every spelling that reaches
  the map unchanged is another budget for the same client. Node writes
  the canonical form for a direct connection, so that half is defence
  in depth — but `req.ip` is read out of a proxy header as soon as
  `TRUST_PROXY` is set, and nothing guarantees what is written there.

  A review of the first attempt caught two things worth recording,
  both of them the same mistake: deciding what an address is from the
  shape of the string. The first read *any* address ending in a dotted
  quad as that IPv4 address, so `2001:db8::1.2.3.4` keyed as
  `1.2.3.4` — not merely a bypass but a way to put a chosen victim in
  lockout, since ten failed logins from it would have blocked whoever
  really holds `1.2.3.4`. A quad only means IPv4 behind the v4-mapped
  or v4-compatible prefix, and `embeddedIpv4` now checks that; anywhere
  else the quad is rewritten as two hex groups and narrowed like any
  other IPv6 address.

  The second was the fallback. Anything unparseable keyed on itself,
  which is how a limiter silently stops limiting: a proxy appending the
  source port to `X-Forwarded-For` (Azure App Service does it, so does
  any nginx writing `$remote_addr:$remote_port`) would have given every
  counter here a fresh key per TCP connection, IPv4 clients included —
  the very hole this change set out to close, restored through another
  door. Ports, brackets and zone ids are now stripped, and what is
  still unreadable **fails closed** onto one shared `"unknown"` key.
  One shared bucket is the safe way to be wrong for a counter, it caps
  what an attacker can grow the map with, and it is visible: the
  refusal log prints the key, so a proxy writing something unexpected
  shows up as `"unknown"` rather than as silence.
- ~~A 429 that does not say which 429 it is~~ Fixed, 2026-09-15. `/mcp`
  answers two of them, from limiters with windows twenty minutes
  apart, and the request one sent `sendStatus(429)` with no body at
  all. An agent cannot retry sensibly on that, and what it reports to
  its human is an outage — the plausible-but-wrong failure this project
  treats as the worst kind. Both now carry `Retry-After` and a body
  with `retryAfterSeconds`, counted to the end of the window that is
  actually running rather than rounded up to its length. The `/events`
  client reads neither, which costs nothing.
- ~~get_top_languages could report more sessions than existed~~ Fixed,
  2026-09-15, found by pointing the finished tool at real traffic
  rather than by reading it. `visitor_language` is stored per event,
  not per session, so `COUNT(DISTINCT session_id) GROUP BY language`
  put a session whose events carried two locales into both buckets.
  Three sessions came back as four, and a share taken off the total
  exceeded 100% — while the tool's own description promised it was
  "the same unit as get_device_breakdown, so the two can be read side
  by side", which it then was not.

  Not only an artefact of hand-made requests: one consentless
  `visitor_id` covers everyone behind an address sharing a User-Agent,
  and those people do not share a locale. It now attributes a session
  to the locale it began with, which is the rule entry pages and
  referrers already use, and the same one-row-per-session shape
  `sessionDevices` was already using twenty lines above — the two had
  simply drifted. Devices could not show the symptom, because device
  and browser come from the User-Agent, which is part of the visitor
  hash and so cannot vary inside one session.
- ~~Address truncation failed open on the forms a proxy writes~~
  Fixed, 2026-09-15, found by a pre-deployment legal review. `truncateIp`
  handed back anything it could not parse, unchanged. The inputs it
  cannot parse are not garbage — they are ordinary addresses wearing
  what a proxy put around them: `1.2.3.4:5678` (Azure App Service writes
  the source port, so does any nginx using `$remote_addr:$remote_port`),
  `[2001:db8::1]`, `fe80::1%eth0`. Behind such a proxy the consentless
  hash took the **whole** address, making the deployment's own privacy
  notice untrue, and the port made it worse than no truncation at all:
  unique per TCP connection, so one visitor counted as dozens and the
  session rule never re-found them.

  Galling because `limiterKey`, twenty lines below in the same file,
  already had `stripWrappers` and a comment naming those exact
  offenders. The two consumers had drifted: one failed closed, the
  other open. They now share the stripping, and `truncateIp` fails
  closed too — merging unreadable addresses into one id under-counts
  visibly, while leaking a whole address into the hash does not.

  The rule about not moving `limiterKey`'s work into `truncateIp` still
  stands and has been sharpened: *canonicalisation* (case, leading
  zeros, the mapped form) must stay out, because it would change the id
  of every existing consentless IPv6 visitor. Stripping wrappers only
  touches input the function could not read at all, which is why it is
  safe to share — verified over 100,000 valid addresses with zero
  differences.
- ~~The URL fragment was never stripped~~ Fixed, 2026-09-15, found by a
  pre-deployment security review. The query-string allowlist exists to
  keep a magic-link token, an `?email=` and a typed search query out of
  the database; the fragment is the other half of that same channel and
  went through untouched, on both sides. An OAuth implicit response
  puts `access_token` and `id_token` there *specifically* so they stay
  out of server logs, and some reset and unsubscribe flows do the same.
  The value reached `events.url` verbatim, the cockpit's recent-events
  table, and `get_recent_events` — which, with a hosted model, means it
  left the server. Two lines, one on each side, and no question loses an
  answer: nothing reads a fragment, and `get_top_pages` groups by path.
- ~~`url` accepted any scheme~~ Fixed, 2026-09-15. `z.url()` accepts
  `javascript:`, `data:` and `file:`, and `/events` is public, so any of
  them could be stored as a page URL, ranked as a "path", and rendered
  in the cockpit. Nothing executes today — the cockpit builds every cell
  through `textContent` and creates no anchors from stored URLs — but it
  was one `el("a", { href })` away from being live, and the CSP does not
  stop a `javascript:` href. Rejecting is visible in
  `get_top_rejected_events`; storing nonsense is not. Note the check is
  a prefix test rather than `new URL().protocol`: a refinement that
  throws turns `safeParse` into a thrown error, which is how the first
  attempt broke four existing tests.
- ~~The cockpit lockout counted requests that carried no password~~
  Fixed, 2026-09-15. `recordFailure` ran whenever the password did not
  match, including when none was sent — which is the normal first step
  of the Basic Auth handshake, sent by every fresh browser session and
  every asset request racing the credential cache. Ten of those in
  fifteen minutes locked an operator out of their own cockpit without a
  single guess having been made, and `limiterKey` grouping IPv6 to a /48
  widened who could trigger it. Only a request that presented
  credentials is a guess. Nothing defensive is given up: a guesser has
  to send a password to guess. (Moot since the session cookie replaced
  Basic Auth — there is no credential-less handshake any more, and the
  limiter sits on the one route where every request carries a guess.)
- ~~Read-only mode~~ Done, 2026-09-15: `READ_ONLY=true` for a
  deployment whose MCP key is meant to be public — the product page's
  own demo instance, where the pitch is "point your agent
  at this and ask", and where the first visitor with an opinion would
  otherwise erase the demo through `delete_visitor_data`.

  Two mechanisms, deliberately not one. On the MCP side the writing
  tool is **not registered** rather than made to check a flag:
  `mcp/admin.ts` is the only module that writes, it is listed in a
  separate `writingToolModules` array in `mcp/tools.ts`, and a
  read-only server never runs it. A tool absent from `tools/list`
  cannot be called at all, and the invariant a future writing tool
  has to honour is "go in the admin module", which is one line in
  `AGENTS.md`, rather than "remember the flag inside your handler",
  which is a sentence nobody rereads. On the cockpit side a
  router-level middleware refuses every non-GET request with a 403
  saying the deployment is read-only, ahead of the CSRF header check
  and every route. Five routes write today (edit, create, reload, both
  resets) and each had grown its own guard; a sixth would have too.
  One check by method covers all of them and the next one, at the
  cost of the invariant that a cockpit write is never a GET — which it
  never should have been. The page hides its write controls and says
  why in the place the reload button stood; the server refuses
  regardless, so the hiding is manners, not protection.

  A UX review of the first attempt found the mode itself was the part
  nobody could see. The only trace of it on the whole page was one
  muted sentence inside a `<details>` that renders closed — while the
  danger zone card simply vanished from Configuration with nothing left
  behind, and the sentence that would explain that lived in a different
  card. Fine for the operator who set the variable on purpose; useless
  for the one who set it by accident and has come looking for the
  button. The mode is now stated once at page level, in the
  `.strip-note` slot under the stat band, where it is on the first
  screen at any width.

  Everything the page says about it is now authored in the HTML and
  only toggled from script. The first version wrote the text and never
  unwrote it, so restarting the server without `READ_ONLY` left "this
  deployment is read-only" sitting beside a working Reload button. It
  also wrote into `#reload-note`, which is a `role="status"` live
  region — permanent state announced afresh on every refresh, in an
  element whose job is transient results.

  `/events` stays open in this mode. Collection is not a "write" in
  the sense that matters here — it is the demo's data source, and a
  read-only demo with no traffic would show nothing. The manifest the
  cockpit lists is cached per mode, so the tools card shows what the
  agent can actually call. Logged once at startup, the same way an
  unset `RETENTION_DAYS` is: the log is where an operator confirms the
  mode they configured is the mode that is running.
- ~~`get_recent_events` stays live under `READ_ONLY`~~ Done,
  2026-09-20: it is now unregistered the same way `mcp/admin.ts` is,
  via a second array (`rawDataToolModules` in `mcp/tools.ts`) rather
  than folded into `writingToolModules` — it writes nothing, so calling
  it a writing tool would be the wrong reason for the right outcome.
  The reason is the one `docs/mcp.md`'s "What leaves your server when
  you ask" already named: it is the only tool returning raw rows
  (`url`, `props`, `referrer`) rather than an aggregate, and `READ_ONLY`
  exists precisely for a deployment whose MCP key is meant to be
  public — a public key handing out raw visitor rows is the same shape
  of problem as a public key that can call `delete_visitor_data`, even
  though nothing is deleted. `docs/mcp.md` used to say there was no
  setting that turned this tool off short of forking
  `mcp/diagnostics.ts`; now `READ_ONLY` does, at the cost of also
  closing every write — a deployment that wants to keep writes while
  dropping only this one tool still has no setting for that and still
  needs the fork.
- ~~The container runs as root~~ Done: the Dockerfile now declares
  `USER node`, the unprivileged uid/gid 1000 the official Node images
  already ship. Nothing in this server needs root — it binds port 3000
  (not a privileged port below 1024), reads its own code, and writes
  only to the database directory. Running as root meant any RCE in a
  dependency landed as root inside the container.

  `/app` deliberately stays root-owned: the runtime user only needs to
  read it, so the application can't rewrite its own code. `/data` is
  chowned to the runtime user, and needs to be writable as a
  *directory*, not just as a file — WAL mode creates `-wal`/`-shm`
  files alongside the database and `LOCAL_BACKUPS` writes a `backups/`
  folder there.

  **The one deployment gotcha this introduces**, documented in the
  Dockerfile and the README: a Docker *named volume* inherits the
  image's ownership when first created, but a *bind mount* of a host
  directory keeps the host's ownership. A root-owned host directory is
  therefore unwritable by the container. Rather than leave that as a
  bare `SQLITE_CANTOPEN`, `db/connection.ts` wraps the open and
  rethrows with the actual cause and the fix (`chown -R 1000:1000`) —
  the same "a mistake should look like a mistake" reasoning applied to
  operations rather than to queries.

  **Verified against the real built image**, not just reasoned about:
  it runs as `uid=1000(node)`, `/app` is root-owned and `/data`
  node-owned, a named volume inherits that ownership and the database
  opens, a root-owned bind mount produces the explanatory error above,
  and the documented `chown -R 1000:1000` remedy then makes it boot.
  That last run also confirmed the directory-not-just-the-file point:
  the container wrote `genug.db`, `-shm`, `-wal` *and* a
  `backups/` folder into the mount. `docker ps` reports `(healthy)`,
  so the `HEALTHCHECK` directive works and not merely the `node -e`
  command inside it; data survives a `docker restart`; and `SIGTERM`
  logs the shutdown line and exits 0.
- ~~Security headers~~ Done: `lib/securityHeaders.ts`. `nosniff` and
  `Referrer-Policy: no-referrer` on every response; the cockpit (the
  only HTML this server serves) additionally gets a CSP plus
  `X-Frame-Options: DENY`.

  `script-src` is `'self'` with **no** `'unsafe-inline'`: since the
  cockpit's scripts moved out of `index.html` into their own files (see
  "Cockpit UI" above) the page carries no inline script at all, so an
  injected `<script>` block simply won't execute. This was originally
  `'unsafe-inline'` because everything was inline in one file — the
  split is what made tightening it possible, which is worth noting as a
  case where a cleanliness change bought a real security improvement.

  `style-src` still allows `'unsafe-inline'`, and that isn't laziness:
  the stylesheet itself is external now, but `cockpit.js` sets inline
  `style` *attributes* for values it computes at runtime (a bar's
  width, a series colour), and those count as inline styles. Removing
  it would mean routing every computed value through a CSS custom
  property — real work for a much smaller gain, since an injected style
  attribute can't execute anything.

  The rest is unchanged: `connect-src 'self'` means even a successfully
  injected script couldn't exfiltrate the analytics data it can see,
  and `base-uri`/`form-action` close two redirection tricks that don't
  need script at all.
- ~~Graceful shutdown~~ Done: `server/index.ts` handles `SIGTERM`/
  `SIGINT` by closing the HTTP server (letting in-flight requests
  finish) and then the db handle before exiting. Not needed for data
  safety — `better-sqlite3`'s WAL mode is crash-safe even on a hard
  kill — but avoids requests being cut off mid-response on a
  Docker/Coolify redeploy.
- ~~`synchronous = NORMAL`~~ Done: `db/connection.ts` sets it right
  after the WAL pragma. SQLite's default is `FULL`, one fsync per
  commit, which means every single page view waits for the physical
  disk before its request completes. Measured against the real schema
  and indexes, that is ~1.4 ms per event and an ingestion ceiling
  around **700 events/sec**; `NORMAL` reaches **~9,000/sec** on the
  same hardware, and the gap barely moves between a 6,000-row table
  and a 5,000,000-row one because the cost is the fsync, not the size.
  The multiplier matters more than it looks: `better-sqlite3` is
  synchronous, so each of those milliseconds is the event loop
  stopped, and at `FULL` the process is saturated on database work
  alone well before the network is.

  The safety argument is entirely dependent on the WAL above it. The
  write-ahead log is append-only and checksummed, so a recovering
  reader stops at the first record that fails its checksum: a hard
  kill can cost the last fraction of a second of events, but cannot
  produce a torn or corrupt database. A crash of this process on its
  own loses nothing, since the OS buffer outlives it. `NORMAL`'s
  reputation for corruption comes from the old rollback-journal mode,
  where it genuinely was unsafe — that hazard does not exist here, and
  anyone changing `journal_mode` must revisit this pragma with it.

  Chosen deliberately rather than defaulted into: pageview counts are
  not a ledger. Paying an fsync per view in perpetuity to protect a
  handful of them from a power cut is the wrong side of that trade, and
  it is the side every comparable SQLite-backed analytics tool takes.
  A deployment that disagrees can set it back in one line.

  What this does **not** change is read cost, which does grow with the
  rows in the window — roughly 30-50 ms per cockpit query at 100k rows,
  350-550 ms at 1M, and 1-1.7 s at 5M, with a dozen such queries per
  cockpit load. `RETENTION_DAYS` is the lever there (see "Data
  lifecycle"), and it is doing more work than its name suggests.
- ~~Resetting the events directory from the cockpit~~ Done: the danger
  zone's second button (`resetEvents` in `schema-registry/registry.ts`,
  `POST /cockpit/events/reset`) deletes every `.json` on the volume and
  re-seeds the image's built-ins.

  **The whole directory, not "the files that aren't built-ins."** There
  is no way to tell the two apart: renaming a built-in means renaming
  its file (see `seedEvents`), so after `page_view.json` becomes
  `seitenaufruf.json` the name — the only thing there is to go on — is
  exactly what changed. A reset that tried to be selective would have
  to guess, and would guess differently depending on what had been
  renamed. Removing everything means one predictable thing, and it is
  what "reset" ought to do anyway: edits to built-ins go too.

  **It refuses when `EVENTS_PATH` resolves to the image's own event
  directory.** That configuration is reachable (point the env var at
  the repo's `packages/schema-registry/events/`, which a clone does by
  default when `/data` is absent), and without the guard the source and
  the target are the same files: the clear deletes the built-ins, the
  re-seed copies an empty directory over itself, every event is gone,
  and it all reports success. Found while writing the tests, not in
  production, which is the only reason it is a paragraph here rather
  than an incident.

  **Stored rows are not touched, and the response says what it
  stranded.** Removing an event type leaves its rows counting toward
  totals while matching no registry-driven query — the failure mode
  "Failure behaviour" exists for. `lib/orphanedEvents.ts` and the
  cockpit's orphaned panel would report them on the next load anyway;
  the route returns them too, because the moment of the reset is the
  only one where the person can still connect cause to effect.

- ~~Device breakdowns counted events~~ Fixed: `getDeviceBreakdown` and
  `getDeviceTypeBreakdown` count sessions. Found by asking, after the
  referrer fix, where else a "what kind of visitor" question was being
  answered per event — the same inflation, and the bigger one of the
  two in practice. Counted per event, one desktop visitor reading
  twenty pages outweighed ten phone visitors reading two, so "most of
  my traffic is desktop" could mean nothing more than "my desktop
  visitors click around more". A session happens in one browser on one
  device, which makes it the honest unit; `getTopLanguages` had already
  reached the same conclusion and ranks by distinct visitors.

  The audit behind it, so the next person doesn't redo it:
  `get_top_pages` counts views and should (it means "most viewed");
  entry/exit/bounce pages and events were already per session;
  `get_top_events`, `get_by_property` and `get_property_sum` count
  events, which is what they are asked about; `get_traffic_summary` and
  `get_segment_summary` report sessions and events side by side and
  label both. Referrers and devices were the only two answering a
  visitor-shaped question in an event-shaped unit.

- ~~A wrong confirmation password answered 401~~ Fixed: both danger-zone
  routes answer 403. `/cockpit` sits behind Basic Auth, so a browser
  reads *any* 401 from this origin as "the credentials I cached are
  wrong" and discards them — one typo in the confirmation field then
  broke every later request on the page, including the retry with the
  correct password, and the page could not even reload itself
  (`ERR_INVALID_AUTH_CREDENTIALS`). 403 is also the honest code: the
  request authenticated fine, it got through Basic Auth to reach the
  handler; it is the retyped confirmation that failed. The 401 that
  does belong to this origin is the middleware's, and it carries
  `WWW-Authenticate`. The database-reset button had shipped with this
  since it was added. (The code is unchanged since the session cookie
  landed, but the reason is new: `cockpit.js` now reads a 401 as "the
  session ran out" and leaves for the login page, so a 401 here would
  throw the owner out mid-confirmation. Same failure, new mechanism.)

- ~~Reclaiming disk space after retention/deletion~~ Done:
  `db/migrations.ts` sets `PRAGMA auto_vacuum = INCREMENTAL` on the
  database. It has to run before any table exists to take effect
  without a full `VACUUM`, so it lives at the top of migration 0.
  `server/index.ts` then
  calls `db.pragma("incremental_vacuum(1000)")` once a day,
  unconditionally (not just when `RETENTION_DAYS` is set, since
  `delete_visitor_data` can free space too). Without this, `DELETE`s
  free up space inside the database file but never actually shrink it
  on disk — `RETENTION_DAYS` would otherwise not do what its name
  promises. Deliberately not a plain scheduled `VACUUM`: that rewrites
  the entire file in one blocking pass, and `better-sqlite3` is
  synchronous, so it would freeze the whole process (no `/events`,
  cockpit, or MCP) for however long that takes.
- ~~Structured logging~~ Done: `lib/logger.ts`'s `logInfo`/`logError`
  replace every free-text `console.log`/`console.error` call (startup,
  shutdown, and each background job's failure path) with a single-line
  JSON object (`level`, `msg`, `ts`, plus caller-supplied fields —
  `logError` also serializes the error's stack, still on one line since
  `JSON.stringify` escapes newlines within a string rather than emitting
  them raw). No dependency added — still just `console.log`/
  `console.error` underneath — but now a real log aggregator (or a
  person grepping raw logs) can parse every line the same way, instead
  of each call site inventing its own free-text message shape.
- **Open items start here.** Each carries a size — S is one sitting, M
  a few, L more than a weekend — and when it matters. Grep `**Open,` to
  list them; there is no separate backlog file to drift out of step with
  this one.
- **Open, 2026-09-18 · L · someday:** Cockpit auth beyond a single
  shared password. **Still open**, and deliberately not closed by the
  session cookie shipped on 2026-09-18 (see "The cockpit signs in
  instead of re-sending a password" below): that change bought logout,
  expiry and a CSRF property, and did nothing at all about a password
  that leaks or is shared, which is what this item is about. What is
  left is per-user accounts — a user store, hashing, invites, resets —
  hence L, and hence "someday" rather than "before beta": for anyone
  who needs more than one credential the honest answer is the reverse
  proxy's own auth (Cloudflare Access, Authelia, Tailscale), which
  gives real accounts and MFA for a paragraph of documentation instead
  of a weekend of code. Building it here would be rebuilding that,
  worse, in a single-tenant tool.
  "Explicitly out of scope for v1" (above) reasoned this was fine
  because the cockpit was a single-owner preview tool; the failed-
  attempt lockout (above) hardens that one password against guessing
  but doesn't change what happens if it leaks or is shared. Worth
  revisiting now that the project has moved from "the maintainer's own
  site" toward being run and looked at by others — not a blocker, but
  flagged so it isn't decided by default before going public.
  `/mcp` was deliberately not included here: it's meant to be reachable
  by an agent holding a key, already sits behind the failed-attempt
  lockout and the per-address request limit, and writing tools are
  unregistered under `READ_ONLY` — the cockpit's single static password
  is the weaker of the two.
- ~~**The cockpit signs in instead of re-sending a password**~~ Done,
  2026-09-18. HTTP Basic Auth is gone; `POST /cockpit/session` exchanges
  `COCKPIT_PASSWORD` for a signed cookie (`lib/cockpitSession.ts`,
  `lib/cockpitAuth.ts`), and a Log out button clears it. What this
  bought, in order of how much it matters:

  - **CSRF, properly.** A browser attaches Basic credentials to a
    cross-site form POST by itself; it will not send a `SameSite=Lax`
    cookie on one. The `X-Genug-Cockpit` header stays as a second lock
    (see "What a reload cannot pick up" above).
  - **Logout and expiry**, neither of which Basic Auth has. Twelve
    hours, and the button signs out every browser at once — with one
    password there is one session, and the reason to press it is that a
    copy is somewhere it should not be. Only a live session sending the
    `X-Genug-Cockpit` header can do that. The logout route needs no
    session, and at first any request to it moved the watermark, so a
    loop of unauthenticated POSTs kept the owner signed out (2026-09 review).
    Anyone else only gets their own cookie cleared.
  - **The lockout stopped counting the wrong things.** It sat on every
    request under `/cockpit`; now it sits on the sign-in route alone, so
    a page full of assets cannot spend the budget and a locked-out
    address that already holds a session keeps working.

  Three things the `security-expert` review changed, all before any of
  it shipped:

  - **The key is derived with `scrypt`, not HMAC.** Deriving it from the
    password is the good part — rotating `COCKPIT_PASSWORD` then ends
    every open session for free, with no second secret to configure and
    no session store to clear. Doing it with a *fast* hash would have
    been a regression against Basic Auth: a cookie is then an offline
    cracking oracle for a human-chosen password, guessable billions of
    times a second on hardware this server never sees, where the
    ten-failures lockout is irrelevant. A stolen cookie would have been
    worth the password itself rather than twelve hours. scrypt is slow
    and memory-hard on purpose, and the cost is paid once at startup.
  - **The redirect-or-401 decision reads `Sec-Fetch-Dest`, not
    `Accept`.** `Accept` is the obvious test and the wrong one: `fetch`
    sends `*/*`, which matches `text/html`, so every JSON call in the
    cockpit would have been answered with the login page's HTML and
    surfaced as a parse error. Anything sending neither header gets the
    401, which is the safer of the two to be wrong about.
  - **The redirect target is a constant.** Never `?next=`, never
    `Referer`: a sign-in page that forwards wherever it is told is how a
    password gets typed into someone else's copy of it.

  Smaller decisions worth not re-litigating: `SameSite=Lax` rather than
  `Strict`, because Strict also withholds the cookie on an ordinary link
  and opening the cockpit from a bookmark in a chat window would land on
  the login page with a live session unused — while Lax already
  withholds it from every cross-site write. `Secure` unconditionally
  rather than from `req.secure`, which is only as true as `TRUST_PROXY`
  says; `http://localhost` is a secure context so a local run still
  works, and the login page names the failure (accepted password,
  dropped cookie) instead of leaving it to read as a wrong password.
  `Path=/cockpit`, so the owner's session is never sent to `/events`.
  The unauthenticated allowlist is an exact-match set of four paths —
  the login page, its script, the stylesheet and the theme switch — and
  deliberately not `index.html`, so "the cockpit shell is public" never
  becomes something a later change quietly relies on.

  What it cost: `curl -u` no longer reaches the cockpit (`docs/deploying.md`
  shows the two-step version), and a browser that refuses the cookie —
  a plain-HTTP LAN address — now fails at sign-in rather than working.
- ~~An enum prop type~~ **Not doing it, 2026-09-18.** A
  `"string.enum"` rule with an allowed-values list, so a prop could be
  validated against a closed set instead of accepted as free text. It
  would buy one thing — a typo'd value caught rather than quietly
  splitting a number, `small` 40 beside `Small` 12 reading as two
  things — and cost more than it buys:

  - **An enum is a validation rule, and a prop that fails validation
    rejects the whole event** (`routes/events.ts`, `invalid_props`).
    The day a site starts sending a plan called `enterprise` that the
    schema does not list yet, those orders stop being recorded — not
    the field, the purchase. A deployment's own code changes far more
    often than its analytics schema does, so that gap is not
    hypothetical. This is the same reasoning already written into two
    existing rules: the cockpit may not change validation on a live
    event, and a prop added from the cockpit is forced optional. An
    enum is exactly the kind of rule that gets ahead of reality and
    stops collection while looking fine.
  - **The half that helps the agent is already free.** A prop
    description saying "one of: small, medium, large" reaches the agent
    through the schema-registry resource and `list_event_types`, which
    is where it would have read an enum from anyway. That is a sentence
    per prop, no code, and it cannot reject anything.
  - **The typo case is visible without it.** `get_events_by_property`
    returns the values ranked, so both spellings appear side by side in
    the answer.

  If split values ever turn up in a real deployment, the fix to build
  then is a **report** — "these two values look like the same thing" —
  in the diagnostics family beside orphaned events, where being wrong
  costs a false suggestion rather than a lost conversion. Not a rule
  that throws traffic away.

  What this does not close: nothing asked for it, which is the other
  half of the answer. The original entry called it "genuinely useful"
  on the strength of cleaner data, and cleaner data is worth having —
  just not at the price of the events that make it.
- ~~`_createdAt`/`_updatedAt` metadata on an event definition~~
  **Dropped, 2026-09-18, and replaced by automatic history entries**
  (`lib/autoHistory.ts`). The plan was two dates in each event's JSON
  file, written by the cockpit, so the agent could reason about "this
  changed recently". Three things came out of looking at it properly:

  - **The cockpit is not the only writer, so the dates would lie.**
    Editing these files by hand over SSH is ordinary here — "renaming or
    deleting a built-in is an ordinary file edit" is an invariant in
    `AGENTS.md`. A hand edit would leave `_updatedAt` reading months
    old with nothing looking wrong, and the agent would repeat it as
    fact. That is this project's defining failure, bought at the price
    of round-tripping a field through four write paths.
  - **The accurate half is free and was never the useful half.** The
    filesystem already records when a file was last written, and a hand
    edit updates it. But re-seeding after Reset events and restoring a
    backup both reset it, so it honestly means "when this file was
    written here" — not "when the definition changed".
  - **What the dates were for is mostly already covered.** The worry
    was a number moving because the vocabulary changed rather than the
    website. Only a rename, a delete and Reset events can do that, and
    all three already strand rows that `lib/orphanedEvents.ts` finds and
    both the cockpit and `get_orphaned_events` report. Editing an
    event's words and adding a prop (forced optional) move no number at
    all.

  So those same three writes now append a line to the history log
  instead, marked `Recorded automatically:` — the log the agent is
  already told to read before attributing a change to a cause. A dated
  sentence saying the event was renamed and whether its rows came along
  is both true whoever made the change, and more use than a date saying
  only when. Creating an event and editing its wording write nothing:
  a log of every write is a log nobody reads.

  Two ways the first version wrote something false, both found by the
  `testing-specialist` review before it shipped, and both the exact
  failure the feature exists to prevent — a confident cause for a drop
  that never happened:

  - **"No rows moved" is not "rows were stranded".** `editEventFile`
    returns `movedRows: 0` both when the owner declined to carry the
    rows across and when there were no rows at all, and the note read
    the second as the first. An event renamed the day it was created
    would have been recorded as having stranded its traffic. The route
    now counts what was stored under the old name before the edit, so
    "it had no stored events" is a state of its own.
  - **A deleted name can come back.** Deleting or renaming away from the
    event carrying `_pageView` hands that name to the built-in stand-in
    (`registry.ts`), so the rows under it match a registered event again
    and nothing is stranded. Both call sites now ask the reloaded
    registry rather than assuming, which is also what the reset route
    had been doing correctly all along.

  The rename and delete forms ask **why**, optionally, and append it as
  `Reason given: …` — the `update-reason` idea from the original
  backlog item, kept at its cheap end. Optional and never nagged at:
  a rename that fixes a typo should not demand a written justification,
  and a required box is a box filled in with "." within a week. It is
  asked in the form because that is the one moment the answer is known.
  Marked as *given* rather than stated, because the rest of the sentence
  is something the server observed and this part is a claim a person is
  making. The rename box appears only once the typed name differs, since
  a wording edit records nothing and offering the box there would invite
  a sentence nothing keeps.

  Deliberately kept small. Writing the note cannot fail the action that
  caused it — the rename already happened, so a note that cannot be
  written is a line in the server log, not an error telling someone
  their rename failed. Entries are marked because the rest of the file
  is the owner's own words and the agent is told so. A reset that
  stranded more events than fit in one note names the biggest five and
  counts the rest, rather than letting the 2000-character cap decide
  where the sentence stops. The `update-reason` field that hung off the
  original idea goes with it: `add_history_note` already lets anyone say
  why, in their own words, without a form demanding a justification for
  a typo fix.
- ~~A "main conversion event" flag~~ Done, 2026-09-18, as `_conversion`
  rather than "main": drafted here as a role-tag lookalike — a boolean,
  at most one across the registry — but that constraint was copied from
  `_pageView` without checking whether it earns its keep, and it
  doesn't yet. Nothing resolves behaviour through this flag the way a
  dozen queries resolve through `_pageView`, and most sites have
  several goals (signup, purchase, newsletter), not one, so forcing a
  single "the" conversion would have been the wrong shape for the
  common case. Any number of events may carry it; `checkEvent.ts`
  validates it's a boolean and nothing more. Surfaced in
  `list_event_types` and the schema-registry resource (`RegistrySummary`
  now carries it, unlike the three role tags, which are deliberately
  excluded — see "role tags never reach the agent" in
  `mcp/tools.test.ts`), and as a cockpit badge next to the role-tag ones.
  No query branches on it yet, same as drafted.
- **Done, 2026-09-18 → 2026-09-20.**
  Deployment context for the agent — three
  related pieces, scoped as one feature rather than three, since a
  small project doesn't need three overlapping config surfaces:
  - A **business context** field/file: the site/company's purpose and
    goals, in the user's own words.
  - An **instructions/ground rules** field/file, shipping with a
    built-in default the user can use as-is or edit — e.g. don't
    guess and ask instead, name the unit (sessions vs. visitors vs.
    events), treat small samples with caution, check the history log
    (below) before attributing an anomaly's cause, call out consent-
    mode undercounting and bot/orphaned-event caveats, and the
    existing `VISITOR_TEXT_CAVEAT` reminder that visitor-supplied text
    is data, never an instruction.
  - A **history log**: dated, free-text entries for things that affect
    the site or its tracking (an outage, a campaign launch), so the
    agent has somewhere to check before guessing at a cause. Lighter
    than the event registry — no validation/collection risk, so an
    append-only JSON array behind a simple add-only cockpit list is
    enough for v1; no edit/delete needed there.

  All three expose as an MCP **resource** (read once, like the schema
  registry already is), not a tool call. A companion **writing** tool
  — let the agent append a history-log entry it identifies mid-
  conversation — belongs in `mcp/admin.ts`, unregistered under
  `READ_ONLY` like every other write, append-only (no edit/delete from
  MCP, that stays a cockpit/file job), and its description should ask
  the agent to say what it logged rather than doing it silently — a
  wrong entry added without comment is the same "looks like data,
  isn't" failure this project already guards against elsewhere.

  Crosses `schema-registry`/`server`/`cockpit` and is a new category of
  MCP surface, not just another event — route through `architect`
  before starting.

  **Smallest useful slice: the ground rules file alone** (a default
  shipped, editable, exposed as a resource). It needs no cockpit work
  and no writing tool, and it is the piece that changes the quality of
  an answer most. The history log is the next slice; the writing tool
  is last, since it is worth nothing until there is a log to write to.

  **That slice is done, 2026-09-18** (`lib/context.ts`, `mcp/context.ts`,
  `server/context/ground-rules.md`). What the `architect` pass settled,
  and why, since each was a fork:

  - **Its own directory, `CONTEXT_PATH`, not a file in `EVENTS_PATH`.**
    Four places filter that directory for `.json` — `loadEvents`,
    `seedEvents`'s copy loop and its `hasEventFiles`, and
    `resetEventFiles`'s removal list. A `.md` there would be skipped by
    the seeder and would survive Reset events: it works, by accident,
    and mixes the vocabulary the collector validates against with prose
    for the agent.
  - **Markdown, not JSON.** An owner editing prose inside a JSON string
    types `\n` by hand, and JSON invents a *malformed* state that then
    needs a failure path designed for it. A `.md` file has no parser, no
    dependency and no malformed state.
  - **Its own ~15-line seeder, not `seedEvents`.** That one's rule is
    "seed only when the directory holds no event files", which exists
    for the rename/duplicate-tag problem and has no analogue here. The
    single-file rule is `COPYFILE_EXCL`: absent → copy, present → leave,
    with the filesystem refusing the overwrite rather than a
    check-then-copy that can race itself.
  - **Read per request; no live binding.** A few KB beside synchronous
    SQLite queries. The live-binding pattern exists to stop a consumer
    caching a module-level constant; not creating the constant removes
    the footgun instead of managing it, and an edit applies with no
    restart and no cockpit button.
  - **One resource, composed under fixed headings.** `## Ground rules`
    now; the other two pieces become `## About this site` and
    `## History` in the same document. Additive, so an agent that knows
    the URI needs no retraining and there is never a second one to
    teach. When the history log lands it stays JSON on disk — the
    writing tool writes JSON, the agent reads prose rendered from it —
    rather than forcing the owner's prose into a JSON body.
  - **Every degraded state says so in the document itself.** Missing,
    unreadable, deliberately emptied, over the 32 KB cap: each is named
    in the text the agent receives. Serving the shipped default while
    the owner's own file sits unread is the "plausible while wrong"
    failure this file keeps returning to — the agent would follow rules
    nobody currently intends, and read as though nothing were amiss.

  One thing deliberately *not* done: **the cockpit cannot edit this
  file** — only shell access to the volume can. That is the security
  boundary: the cockpit is one shared password, and an agent reading
  this document also has `mcp/admin.ts` registered on any
  non-`READ_ONLY` deployment, so an edit box would promote "knows the
  cockpit password" to "steers the owner's agent". If piece two wants a
  cockpit surface, read-only is the cheap answer. Separately, `READ_ONLY`
  means the MCP key is published, which makes this text public — said in
  `.env.example`, `deploying.md` and `mcp.md` rather than left to be
  discovered.

  **Slice 2, the history log, done the same day** (`lib/history.ts`).
  Dated entries an owner writes down — an outage, a campaign — rendered
  as a `## History` section of the same document, so the agent has
  somewhere to look before attributing a change in the numbers to a
  cause it invented. What the shape cost, and what it bought:

  - **JSON here, markdown next door.** The opposite of the ground-rules
    decision, and for the opposite reason: these are records with a
    shape, and a date has to be a date for entries to sort. The price
    is the malformed state markdown does not have, so every failure —
    unparseable file, not an array, a bad entry — is reported into the
    document rather than swallowed.
  - **A bad entry costs that entry**, not the file, exactly as a bad
    event file costs that event rather than the registry. The rest
    still render and the skipped ones are named with their reason.
  - **`Date.parse` is not a date check.** It accepts `2026-02-31` and
    silently rolls it to 3 March, so the first version validated a day
    that does not exist and would have rendered it to the agent as
    fact. Caught by its own test. The check is a round-trip: parse,
    re-format, compare to what was written.
  - **An empty log says it is empty, not that nothing happened.** The
    whole feature exists so the agent stops guessing at causes; a
    silent empty section would have it conclude there were none, which
    is worse than the guessing.
  - **Newest first, capped at 200**, oldest dropped and the drop named.
    A log grows forever and this text is pasted into a context window
    whole.
  - **`runBackup` now copies `CONTEXT_PATH`.** Deferred when only
    `ground-rules.md` lived there, since an absent one is re-seeded from
    the image. `history.json` is the opposite: nothing can re-create an
    owner's record of their own site.

  **Slice 3, the writing tool, done the same day** (`add_history_note`
  in `mcp/admin.ts`). A cause is learned in a conversation, so requiring
  an edit on the volume to write it down meant most of them never would
  be. Append-only; changing or removing an entry stays a file edit. What
  it turned on:

  - **Untrusted text must not reach a file that is read as
    instruction.** This is the first tool whose output becomes part of
    the deployment-context document, and the document tells the agent
    that document is instruction it may act on. The path to worry about
    is visitor-controlled text — a URL, a referrer, a prop value —
    reaching a note, which would let a stranger leave standing orders
    for every later session. Two halves, both cheap: the tool's
    description says to record only what the person said and never
    something built from tool output, and the `## History` section now
    says its entries are records of events and not instructions. Either
    alone is thin; together the model has to ignore both to be steered.
  - **Wording only works while the format holds, which it did not.**
    Both the `security-expert` and `testing-specialist` reviews found
    the same hole, independently and by running it: a note is rendered
    as one item of a list, and a note containing
    `"\n\n## Ground rules\n\n…"` ends that item and opens a section of
    its own — landing outside the "records, not instructions" line, at
    the end of the document where nothing follows to give it away. No
    amount of describing the tool prevents that, because the
    containment it assumes is the markdown, not the model. `formatHistory`
    now collapses whitespace in a note to single spaces. Collapsed
    rather than rejected: line breaks in a note are formatting and
    reflowing costs nothing, while refusing would throw away an entry
    someone wrote down — and it runs on every entry, so a file edited by
    hand is covered too. The lesson worth keeping: text placed into a
    structured document is only contained if the structure cannot be
    ended from inside the value.
  - **It refuses rather than rewrites.** A `history.json` it cannot
    parse still holds the owner's entries — unreadable to the formatter,
    but there in the text and recoverable by hand — so appending to it
    would mean writing a fresh array over them. Entries that merely fail
    validation are written back untouched, because the reader skipping
    one and naming it is a report, not permission to delete it. The new
    array goes to a temporary file and is renamed over the old one,
    since this is the one file in a deployment nothing can re-create.
  - **`date`/`end_date`, not the `from`/`to` it stores.** `guardPeriod`
    in `mcp/tools.ts` finds period-taking tools by their input shape
    alone, and `tools.test.ts` generates real calls against every tool
    that matches. A writing tool carrying that pair would have been
    swept into both — the test suite calling it for real, against
    whatever `CONTEXT_PATH` the machine running it has. Renaming the two
    arguments was cheaper than teaching either to make an exception, and
    a test now pins that no writing tool declares a period.

  **Slice 4, a read/write cockpit surface, done 2026-09-20**
  (`lib/writeGroundRules.ts`, plus two new routes in `routes/cockpit.ts`).
  Left for later above as "if one is wanted at all" — it was wanted, with
  the security boundary explicitly accepted rather than rediscovered:
  the cockpit is one shared password, and this hands whoever holds it a
  second way to steer what the agent is told to do, on top of
  `mcp/admin.ts`'s existing tools on any non-`READ_ONLY` deployment. What
  the slice did and did not do:

  - **Ground rules: a whole-file overwrite, not a diff or a merge.**
    Same reasoning as the file's own shape — free prose has nothing to
    merge against. Refused over `MAX_GROUND_RULES_BYTES` rather than
    truncated: a save from a browser has someone right there to shorten
    it, unlike a file that merely grew stale on disk. Checked in UTF-8
    bytes (`Buffer.byteLength`), not JS string length — a `.length`
    check would have let a multi-byte-heavy save through that render
    time then truncates mid-character.
  - **History stays add-only from the cockpit**, reusing
    `appendHistoryEntry` unchanged — the same function
    `add_history_note` already called. Edit and delete of an entry are
    still a file edit on the volume, exactly as before this slice:
    giving the cockpit full CRUD over records the agent reads as
    instructions would be a bigger promotion than the ground-rules write
    itself, for a case (fixing a bad entry) that already has a working
    path.
  - **No new CSRF or read-only mechanism.** Both routes are POST/PUT, so
    the router-level gate that already 403s every write under
    `READ_ONLY=true` covers them for free, and both reuse
    `refusesCockpitOrigin` — the same header check every other cockpit
    write passes. Read-only was the one hard requirement carried over
    from the earlier discussion, and it cost no new code.
  - **Read-only degrades the ground-rules box to a read-only view, not a
    hidden one** — unlike a pure write control (the Save button, the
    history add-form), the textarea also carries content someone came
    here to read. Hiding the whole form the way the danger zone
    disappears would have taken the text with it; only the control that
    writes is a write control, so it alone is what read-only hides.
  - **No sanitisation added to the ground-rules text.** The injection
    concern the history note's `oneLine()` fix (above) defends against
    is visitor-adjacent text escaping into a fake heading. Ground rules
    are the owner's own words, already rendered unescaped today by a
    shell edit; moving the edit surface into a browser textarea changes
    who is typing least of all, not what the text is allowed to say.
  - **`GET /cockpit/data` now reads both files too, not just the two
    write routes** — caught by a `security-expert` pass, not designed
    in up front. On a non-`READ_ONLY` deployment this is new: before
    this slice, reaching the deployment-context text needed
    `MCP_API_KEY` or shell access to the volume; now `COCKPIT_PASSWORD`
    alone reads it. The two secrets were already documented as
    separate (`docs/deploying.md`), so a deployment that hands the
    cockpit password to someone without the MCP key — an assistant with
    dashboard access but not agent-config access, say — now has that
    person reading ground rules and the full history log too. Consistent
    with, not beyond, the trust equivalence already accepted for the
    *write* side above; said explicitly in `docs/deploying.md`'s
    `COCKPIT_PASSWORD` row rather than left implicit.
  - **`parseEditBody`'s 64kb body limit and the 32kb ground-rules cap
    are only 2x apart**, and every other write on this router sends a
    few hundred bytes — never close enough for that gap to matter until
    now. JSON-escapes its content (a `"`, `\` or newline in ordinary
    prose costs 2 bytes instead of 1), so text sitting right at
    `MAX_GROUND_RULES_BYTES` can push the *request body*, not the text,
    past 64kb — and body-parser rejects it before `writeGroundRules`'s
    own friendly error ever runs. Caught by `testing-specialist`, not
    exercised by any test until then, since every existing writer's test
    calls its function directly rather than through the route. Fixed by
    giving this one route its own parser at 128kb — comfortably over
    double the content cap even under pessimistic escaping — rather
    than testing around the collision, plus a test that saves content
    made entirely of quote characters right at the cap.

  **Slice 5, business context — the one piece left over from the
  original scope, done 2026-09-20.** The tracking line above sat at
  "slices 1 and 2 of 3 done" for two days; slice 3 was never built,
  including through the cockpit-surface work in slice 4, until the
  user noticed the cockpit was missing something they remembered being
  planned. Same shape as ground rules — free prose, owner-authored,
  rendered into one section of the same document, whole-file overwrite
  from the cockpit — with two real differences from copying it outright:

  - **No seeding, and no built-in default.** Ground rules seeds via
    `COPYFILE_EXCL` because there's a universal default worth shipping.
    History seeds an empty array because its reader needs well-formed
    JSON to append to. Business context is markdown with no parser and
    no universal answer to "what is this site for" — there is nothing
    to seed. `about.md` (`BUSINESS_CONTEXT_FILE`) simply doesn't exist
    until the owner's first save creates it.
  - **"Absent" and "empty" collapse into one wording, and it isn't
    ground rules' wording.** An empty ground-rules file is a deliberate
    opt-out, honoured as "no rules of my own." Business context has no
    opt-out concept — nobody unsets a purpose, they just haven't
    written it down yet — so both states read as "not yet configured,"
    explicit that this is not evidence the site has no purpose, only
    that nobody has said. Getting this the ground-rules way would read
    as false information about the site; getting it silent would let
    the agent invent a purpose. Oversized and unreadable stay separate,
    real failure states, worded the same way ground rules' are.
  - **The byte cap is shared, not duplicated under the wrong name.**
    `MAX_GROUND_RULES_BYTES` became `MAX_PROSE_FIELD_BYTES` — same 32KB
    number, but naming a cap shared by two fields after only one of
    them is the forced-symmetry-with-a-lie this project's own
    conventions warn against elsewhere. `writeGroundRules.ts` and the
    new `writeBusinessContext.ts` both import it.
  - **The writer is duplicated, not extracted into a shared helper.**
    `writeBusinessContext.ts` is a near-line-for-line copy of
    `writeGroundRules.ts` (mkdir, byte-cap check, write, error shape).
    Two call sites is rule-of-three's "not yet," and the ground-rules
    writer had just shipped and been reviewed — extracting a shared
    `writeContextFile` would touch tested, working code for a
    generalization with no third user yet. Revisit if a third prose
    field ever shows up.
  - **The cockpit's byte counter *was* worth generalizing**, unlike the
    writers: `updateGroundRulesCount` became `updateByteCount(textareaId,
    counterId)`, called for both fields. No domain logic, two real and
    immediate call sites, zero risk — the opposite trade-off from the
    writers above for a reason, not an inconsistency: a five-line
    rendering utility with no state of its own is cheap to generalize
    the moment a second caller exists; a tested server-side writer with
    its own error shape is not.
  - **Order was already decided.** Ground rules, About this site,
    History — settled when the feature was first scoped as one
    document, so this slice only had to place a new heading in the
    middle rather than choose where it goes.

  `VISITOR_TEXT_CAVEAT` stays per-tool regardless of what this file
  says. An owner can delete the default, and the invariant in
  `AGENTS.md` must not quietly come to depend on a file they own.
- ~~A real load test~~ **Done, 2026-09-18.** `scripts/load-events.mjs`
  (a closed-loop generator over plain `node:http`, no dependency) and
  `scripts/fill-events.mjs` (synthetic rows, for measuring queries
  against a database the size a deployment reaches). Numbers, method and
  the hardware they were measured on are in
  `docs/operations.md`. Three things the run settled:

  - **Collection holds at ~2,900 events/s and does not care how big the
    table is** — the same figure at 250k rows and at 5M. Median request
    1.5 ms, p95 14 ms. Writes are synchronous, so concurrency past about
    four buys latency rather than throughput, exactly as predicted here
    before it was measured.
  - **Reading scales with the whole table, not with the window asked
    about.** The cockpit's 7-day page: 77 ms at 100k events, 422 ms at
    1M, 2.5 s at 5M (5.3 s over HTTP with the collector busy). The
    window is fixed across that table; only the history behind it grows.
  - **The cause, found by reading the query plan rather than guessing:**
    the session-scoped queries (`entryPageViews` in `lib/content.ts`,
    and everything else built on `SESSIONS_STARTED_IN_PERIOD`) filter
    the outer query by `event = @pageViewEvent` only, so SQLite walks
    every page view ever recorded and lets the period in solely through
    which sessions qualify. `EXPLAIN QUERY PLAN` shows
    `SEARCH events USING INDEX idx_events_event_ts (event=?)` with no
    `ts` bound.

  Two things the first attempt got wrong, both worth keeping in mind
  when re-running it: one address per worker measured nothing but the
  per-IP limiter refusing the test (600/min, every response a 429), and
  a generator that sends no browser `User-Agent` is dropped as a bot. A
  load test that does not check the rows landed is measuring its own
  fixture.
- ~~Bound the session-scoped queries by time~~ **Done, 2026-09-18**, the
  same day the load test found it. `SESSIONS_STARTED_IN_PERIOD` is no
  longer exported; `IN_SESSION_STARTED_IN_PERIOD` replaces it and is the
  whole condition — `ts >= @from AND session_id IN (…)` — at all seven
  call sites across `content.ts`, `events.ts`, `traffic.ts` and
  `segment.ts`.

  **Shipped as one condition rather than a line added seven times**,
  because the failure mode of the obvious version is a query written
  next year that takes the membership test without the floor: nothing
  breaks, no test fails, that one question is just slow forever. Making
  the floor inseparable from the membership is what stops that. Renaming
  the export is what caught the seven existing sites — the compiler
  found them, not a grep.

  Measured on one 5,000,000-event database, clean build each way: the
  cockpit's 7-day page **2,441 ms → 1,158 ms**, a segmented
  `get_top_referrers` 3.0 s → 1.1 s, `get_steps_funnel` 0.48 s → 0.28 s.
  Year-long windows are unchanged (`get_traffic_summary` over 365 days
  stays at 3.3 s), which is the expected shape rather than a
  disappointment: a year of that database is the database, so there is
  nothing for a floor to exclude. What is left at 5M is roughly
  two-thirds `getStoredEventCounts` and `getOrphanedEvents`, both of
  which read all of history because that is their question.

  **Why it cannot move a number**, which is the only reason it was
  allowed: the subquery admits a session only when `MIN(ts) >= @from`
  over *all* of that session's events, so no row of a qualifying session
  is older than `@from`. All 483 existing tests passed unchanged, which
  is evidence rather than proof — the proof is the sentence above.

  Two new tests, because the change introduced two ways to be quietly
  wrong that no existing test could see. `>=` versus `>`: a session
  whose first event lands exactly on `@from` would keep its session and
  lose that row, reporting its *second* page as where it entered —
  pinned behaviourally in `content.test.ts` and on the SQL in
  `sessionScope.test.ts`. And a ceiling: `ts <= @to` looks symmetrical
  and is wrong, since a session that started late in the period exits
  after it. That one was already guarded behaviourally by the
  straddling-session tests; the new file states it on the condition
  itself, where someone tidying up would be looking. Both were checked
  by mutation — flipping `>=` to `>` fails three tests.

- ~~Check what a small VPS can do~~ **Done, 2026-09-18.** The capacity
  section answered "how much" but not "what do I need to rent", which is
  the question someone actually has before deploying. Re-measured with
  the server confined by CPU affinity and a memory cgroup
  (`systemd-run --user --scope -p MemoryMax=4G`), against an identical
  one-million-event database each time. Numbers in
  `docs/operations.md`.

  **Core count does not matter.** 1 CPU: 2,870 events/s and a 0.30 s
  7-day cockpit page. 2 CPUs: 2,987 and 0.26 s. Unconstrained: 2,972 and
  0.27 s. The second core buys about 4% on the write path and nothing on
  the read path, which is the shape to expect rather than a surprise —
  an event is one synchronous insert and a cockpit panel one synchronous
  query, so there is no second thread for a second core to run. Memory
  peaked around 250 MB whatever the configuration: SQLite reads through
  the OS page cache rather than holding the table, so spare RAM is doing
  the caching, not the process.

  So **2 vCPUs and 4 GB is enough**, and the honest caveat is that this
  varies neither core *speed* nor disk *latency*, which is exactly what a
  VPS changes. Writes are synchronous, so network-attached storage is
  the one thing that could really cut the ingest figure.

  **The methodological trap, which caught this twice before it was
  spotted:** `scripts/load-events.mjs` writes ~60,000 rows timestamped
  *now*, so every one of them lands inside whatever window you measure
  next. Running it against the query fixture took the 7-day window from
  21,000 rows to 148,000 and the page from 0.26 s to 1.25 s — which read
  exactly like "one core is 5x slower" and was nothing of the kind. Read
  latency must be measured on a pristine copy, restored before each run.
  A note now says so in both scripts. The first load test's two traps
  are recorded in the entry above; this is the third, and the same
  lesson: an unrealistic fixture measures the fixture.

  One incidental finding: `days=365` against `/cockpit/data` silently
  returns the 7-day answer, because `ALLOWED_WINDOW_DAYS` is `{1, 7, 30}`
  and `parseWindowDays` falls back to the default. Correct behaviour for
  a page that offers three buttons, and a good way to measure the same
  window twice without noticing.

  **Re-done with the deployment stack, because the first pass measured a
  bare `node` process and nobody deploys that.** Container plus a Caddy
  reverse proxy, everything pinned to the same two CPUs: 2,805 events/s
  in Docker alone, 2,276 with the proxy in front — so the container costs
  ~6% and the hop another ~18%, while read latency is untouched (a
  millisecond on a 220 ms page). Memory is the part the first pass
  understated: `dockerd` and `containerd` are ~200 MB on the host before
  any container starts, so the real bill is ~430 MB, not ~250 MB. Still
  comfortably inside 4 GB, but worth stating, and worth the warning that
  Coolify co-located on the same box brings its own Postgres, Redis and
  Traefik.

  Two things the proxied run does not cover, stated rather than
  estimated: TLS (the proxy spoke plain HTTP) and a slower disk. Both
  push the ingest figure down, neither touches the read figures.

  A third trap for anyone re-running this, alongside the two above:
  **Caddy discards an inbound `X-Forwarded-For` from an untrusted
  source**, so the generator's forged addresses never reach the app and
  every request keys to the bridge gateway — 100% 429s, at a throughput
  *higher* than the real path because refusing is cheap. Caddy is right
  to do that; the test needs `trusted_proxies static 0.0.0.0/0` and
  `TRUST_PROXY=2`, and neither belongs in a real deployment. The pattern
  across all three traps is the same: the generator has to be told the
  truth about the defences, or it measures them instead of the server.

- ~~Run `PRAGMA optimize`~~ **Measured and rejected, 2026-09-24.** The
  app never runs `ANALYZE`, so SQLite plans without statistics. That
  once cost us: a segment's event condition walked the event's whole
  history through `idx_events_event_ts`, now fixed with a unary `+` in
  `lib/segment.ts`. SQLite's advice is to run `PRAGMA optimize` at
  startup and every few hours, so it was measured before being added.

  It makes this app slower. On a 1,000,000-event fill (0.5 s to run),
  with the same answers every time: `get_traffic_summary` over 30 days
  28 ms → 67 ms, `get_new_vs_returning_visitors` 61 → 104 ms, a segmented
  `get_top_referrers` 103 → 148 ms, the cockpit's 30-day page 530 →
  670 ms. Only `get_top_events` got faster (22 → 8 ms). Repeated three
  times each way; the numbers held.

  The cause is in the plan. With statistics SQLite learns that `event`
  has only a few distinct values, and answers a plain date range with a
  skip-scan over `(event, ts)` instead of `idx_events_ts`. That reads
  the period once per event type and fetches rows out of date order. A
  real site also has a handful of event types, so the fixture is not
  the reason.

  If this is tried again: measure through the server as above, and
  compare every tool, not the slow one you were chasing. A statistics
  table changes every plan at once.

### Data lifecycle (legal exposure, not just nice-to-have)

Both done:

- **Retention stays off by default — deliberately, but no longer
  silently.** The obvious-looking fix was to default it to something
  (a year, say), on the same "the default must be the safe one"
  reasoning that made `COCKPIT_PASSWORD` required. That reasoning
  doesn't transfer, and the difference is worth being precise about:
  an open cockpit exposed the deployment's data *to other people*, so
  the insecure default had a victim who never agreed to it. Unbounded
  retention only costs the deployer their own disk — while defaulting
  it *on* would silently delete their data on a schedule they never
  asked for. Between a full disk and quiet data loss, the recoverable
  one is the better default, and it's the one the deployer can see
  coming.

  So the fix is loudness, not a destructive default. The cockpit
  already states it on screen ("Retention: no limit configured — events
  are kept forever"), and `server/index.ts` now logs it once at startup
  for the deployer who never opens the cockpit. A deployment that has
  configured retention gets no message at all, so this never becomes
  noise to scroll past.

  Revisit if a real deployment actually fills a disk — with the
  envelope caps and the 16KB body limit now in place (see "Data
  model"), the realistic growth rate is far lower than it was when this
  was first flagged.
- **Data retention** — `RETENTION_DAYS` env var (see "Configuration"),
  enforced by `lib/retention.ts`'s `pruneOldEvents`, run once at
  startup and once a day thereafter. `pruneOldRejectedEvents` and
  `pruneOldBotActivity` ride along on the same setting and schedule for
  `rejected_events` and `bot_activity` respectively (see
  `get_top_rejected_events`/`get_bot_activity` under "Core product
  value") — one retention knob covers all three tables, not three to
  explain.
- **Data deletion** — the `delete_visitor_data` MCP tool (see "MCP tool
  design"). Consentless visitor_ids rotate daily and aren't linked to a
  real identity the visitor could reference, so this mainly matters for
  the consentful path.

### The README promised an erasure it cannot perform

The legal half of the pre-publish review found the architecture clean —
no third parties, no raw IP stored, no cookie before consent, withdrawal
honoured server-side — and the exposure entirely in what the README
claimed. Three corrections, one of which was a real overclaim.

**"GDPR right-to-erasure" was not true for most traffic.**
`delete_visitor_data` takes a `visitor_id`, and nothing in Genug ever
shows one: the query layer uses it for `COUNT(DISTINCT …)` and funnel
joins, never returns it, and in consentless mode it is a daily-rotating
hash the visitor never sees. So an Art. 17 request from a consentless
visitor cannot be fulfilled — not because the tool is weak but because
the design deliberately keeps no stable identifier. That is what Art. 11
exists for, and the operator has to say so in their notice rather than
inherit an assumption from ours. The tool is still the right tool; the
heading was the wrong promise.

The same bullet now says that deletion does not reach the backups.
Retention and erasure touch the live database only, so the daily
snapshots hold removed rows for up to another 7 days, and an off-host
copy keeps them for as long as it is kept — the recipe here
deliberately omits `--delete`, which is right for backups and wrong for
erasure, so it had better be written down.

**No legal basis was named anywhere.** The README was careful that the
IDs are personal data and then never said what permits recording
them. For consentless mode that is normally Art. 6(1)(f),
which carries a balancing test and an Art. 21 objection route. Added,
along with the Art. 13 and Art. 30 obligations and the one genuinely
good piece of news worth stating out loud: self-hosting means there is
no analytics vendor to sign an Art. 28 DPA with.

**Whether the IP+UA hash needs § 25 TDDDG consent is left open, on
purpose.** No cookie means the storing half of § 25 is clear; the
access half, and how the EDPB reads it, is genuinely unsettled, and
every cookieless analytics tool is standing on the same ground. The
README now says it is our reading and to have counsel confirm it for a
client's site, rather than implying it is free. Overstating this would
be the same mistake as the erasure heading.

Two smaller inaccuracies went with them: the field table implied `props`
is entirely the operator's choice, when the built-in `page_view` ships
`page_title` and `document_language`; and rejected requests were
described as holding no visitor data, when a validation message can
quote up to 200 characters of what was sent.

### Core product value

- ~~More MCP tools~~ Done: `get_steps_funnel`, `get_top_referrers`,
  `get_top_events`, `get_by_property`, `get_property_sum`,
  `get_recent_events`, `get_top_rejected_events`, `get_bot_activity`,
  `get_device_breakdown`, `get_average_session_duration`,
  `get_top_entry_pages`, `get_top_exit_pages`, `get_top_bounce_pages`,
  `get_top_entry_events`, `get_top_exit_events`, `get_daily_traffic`,
  `get_traffic_by_day_of_week`, `get_traffic_by_hour`,
  `get_new_vs_returning_visitors`, `get_top_languages` and
  `get_consent_breakdown` — see "MCP tool design" above for what
  each does. `compare_periods` was
  also built, then removed: unlike the others, it encoded no logic a
  server needs to guarantee correctness for — it was just "call
  `get_traffic_summary` twice and subtract," which an agent can already
  do itself with the tool that already exists. Keeping it around would
  have been a convenience tool, not a necessary one, so it didn't
  survive the "does this need to be server-side" question the other
  tools all pass (`get_steps_funnel`'s ordering logic, `get_by_property`'s
  registry validation, `get_top_referrers`'/`get_top_pages`'s grouping).
- `get_recent_events(limit)` (`lib/recentEvents.ts`'s `getRecentEvents`,
  previously only used internally by the cockpit) — the most recent
  raw events, newest first. Not for aggregate analysis; for spot-checking
  that tracking is actually working, or seeing exactly what's being
  recorded right now, the same debugging spirit as `get_traffic_summary`'s
  zero-data note.
- `get_orphaned_events()` (`lib/orphanedEvents.ts`'s
  `getOrphanedEvents`) — stored events whose type the registry no longer
  has. The mirror image of `get_top_rejected_events` below: that one
  reports requests that never became data, this one reports data that
  has stopped being visible.

  There is exactly one way to produce these, which is what makes the
  tool precise: an event name that was never registered is rejected at
  ingestion, so a row can only be orphaned by its event being renamed or
  deleted afterwards. The cockpit reports the same thing on its Schema
  registry card.

  **What an orphaned row costs is uneven**, and measured rather than
  assumed. Queries that group by whatever is in the column still see
  them under the old name (`get_top_events`, `get_recent_events`), so
  totals do not drop. Queries that resolve a registered name do not see
  them, and no tool accepts the old name as an argument. The bad case is
  renaming the **page-view** event: verified against a running server,
  three page views went from `viewEvents: 3, interactionEvents: 0` to
  `viewEvents: 0, interactionEvents: 3` across the rename, with
  `topPages` going from three entries to none. The session count and the
  event total were unchanged.

  That is the reason this is worth a tool and a cockpit panel rather
  than a line in the recipe. "Your numbers went to zero" gets noticed.
  "Your numbers are the same but the split is wrong" does not, and an
  agent reading those numbers has no way to tell — which is why the tool
  description tells it explicitly what to distrust when the result is
  non-empty.

  Not period-scoped, unlike every other tool here. A rename's leftovers
  age out of any window while staying just as invisible, so a
  period-scoped version would stop reporting the problem precisely when
  it had been there longest. No `limit` either: the rows can only be
  produced by the deployment's own renames, never by traffic, so the
  number of distinct names is a handful and not something a visitor can
  inflate.

  **It reports orphaned rows, not renames.** Nothing in the system knows
  a rename happened: a file with one name stopped existing and a file
  with another started, which is indistinguishable from deleting one
  event and adding an unrelated one. So the tool can say "3 events are
  stored under `page_view`, which nothing registers" and cannot say
  "you renamed this to `seitenaufruf`". Only the operator knows the
  mapping, which is the first reason the fix is theirs to run — before
  any argument about what an agent should be allowed to do.

  A heuristic was considered and dropped: a disappeared event and a new
  one with an identical prop schema are *probably* a rename. Probably is
  not good enough when acting on it means merging two datasets, and
  offering a wrong guess confidently is worse than offering nothing —
  the same reasoning that keeps every tool from returning an empty
  result that reads as "no data".

  **No CLI for the fix either**, which was considered once it turned out
  the runtime image has no `sqlite3` binary and no `python3` (checked
  against `node:24-slim`, not assumed) — so "run this UPDATE" had no
  stated way to be run at all, and the recipe's "stop the server first"
  was self-defeating, since a stopped container cannot be `docker exec`ed
  into. A `renameEvent` command could have added guards raw SQL cannot:
  refuse unless the new name is registered, refuse if the old one still
  is, back up first.

  Rejected on the project's own record: "the role tags, the preamble and
  the short cache exist only so a deployment can rename a built-in
  event. Nobody has... don't extend it" (see "Release reviews" below). And the
  guards are worth less than they sound — the cockpit hands the operator
  the exact old name to copy, which is the mistake they would mostly
  catch, and a one-liner already prints the row count. What was actually
  missing was a command that works in the image, which is a
  documentation fix, not an entry point. The recipe now carries one,
  tested rather than written from memory.

  **Also deliberately read-only.** The obvious companion is a tool that
  renames the old value to the new one, and it was rejected: this
  project has exactly one write tool (`delete_visitor_data`) and the
  prompt-injection position in "The agent reads attacker-controlled
  text" rests on that being true and its blast radius being one
  visitor's rows. "Rewrite every event name in the table" is not
  bounded that way, has no undo beyond the last backup, and would serve
  an operation that happens roughly once per event, ever — by someone
  who has just hand-edited a JSON file on a server and can run one
  `UPDATE`. Diagnosis is the agent's job; the destructive half stays
  with a person who meant it. The tool description says so, so the agent
  doesn't imply it can do more than report.

- `get_top_rejected_events(period, limit)` (`lib/rejectedEvents.ts`'s
  `getTopRejectedEvents`) — a quality-assurance tool, not an analytics
  one. `routes/events.ts` rejects a request at three points: a malformed
  envelope, an unregistered event type, or props that don't match that
  event's own schema — each one logged to a separate `rejected_events`
  table (`db/rejectedEvents.ts`'s `insertRejectedEvent`), since a
  rejected request never got a trustworthy visitor/session identity and
  so can't just be a differently-tagged row in `events`. This tool
  groups those by `(reason, event)` and ranks by count, same "SQL groups,
  JS/SQL re-aggregates" shape as `get_top_events` — for
  `unknown_event_type` specifically, the event name itself is usually a
  typo (e.g. `produt_added_to_cart` showing up repeatedly) and is often
  more useful than the count alone. `event` is nullable: a malformed
  envelope may not even have a readable event name to report. Each group
  also carries `lastDetail` — a short "path: message" summary of the
  most recent occurrence's actual Zod validation failure (e.g.
  `props.value: Expected number, received string`), captured in
  `routes/events.ts` at the moment of rejection and stored in a
  `detail` column rather than thrown away — the count
  alone couldn't tell a deployer *why* `invalid_props`/`invalid_envelope`
  requests kept failing, only that they did. Null for
  `unknown_event_type`, where there's no Zod error to summarize and the
  event name is already the useful detail. Uses the same "bare column
  alongside a MAX() aggregate comes from the row that produced it" trick
  as `getEntryPages`/`getExitPages`, to surface the *latest* detail per
  group rather than an arbitrary one. The cockpit shows a plain count
  (`getRejectedEventCount`) as a fourth
  stat card alongside Sessions/Events; pruned by the same
  `RETENTION_DAYS` job as `events` (`lib/retention.ts`'s
  `pruneOldRejectedEvents`) rather than a second retention setting to
  explain — this is diagnostic data with no reason to outlive the real
  events it was rejected instead of becoming.
- ~~Bot/spam filtering~~ Done: `lib/bots.ts`'s `isBotUserAgent` rejects
  requests to `/events` whose `User-Agent` matches a short list of known
  crawler/automation-tool signatures (or is missing entirely), silently
  (`204`, same response a real event gets — no client-visible error for
  a false positive). Best-effort only: catches bots that identify
  themselves honestly, which covers the vast majority of crawler
  traffic, not one deliberately spoofing a real browser's UA — that's
  an accepted gap, not something this project is trying to solve.
  Silent to the client, but not invisible to the deployer: `get_bot_activity`
  below gives coarse volume visibility, since previously a dropped bot
  request left no trace anywhere at all.
- `get_bot_activity(period)` (`lib/botActivity.ts`'s
  `getBotActivityCount`) — how many requests `isBotUserAgent` dropped in
  a period. Deliberately not a row per bot hit in a table, unlike
  `rejected_events` above: bot traffic can spike far more
  unpredictably than genuine visitor or integration activity (a
  scraper hammering the site), so writing one per request would scale
  with exactly the traffic pattern most likely to spike, putting real
  write pressure on SQLite's single synchronous writer right when it's
  least wanted. Instead an in-memory counter
  (`createBotActivityCounter`/`recordBotHit`/`drainBotHits`) accumulates
  hits for free (no I/O at all), and a background job in `server/index.ts`
  drains and persists it once an hour — at most 24 tiny writes a day
  regardless of volume, and none at all for a quiet hour, since a row is
  only written when that hour's count is actually nonzero. The tradeoff
  against a full log: at most about an hour of counts can be lost on a
  crash or redeploy, an accepted gap given this is a rough volume signal
  ("did we get an unusual crawler surge") rather than a precise count
  anything else depends on.
- `get_daily_traffic(period)`, `get_traffic_by_day_of_week(period)`, and
  `get_traffic_by_hour(period)` (`lib/traffic.ts`'s `getTrafficByDay`/
  `getTrafficByDayOfWeek`/`getTrafficByHour`) — close a real gap:
  `get_traffic_summary` only ever gave one aggregate number for a whole
  period, so there was no way to ask "is traffic trending up," "which
  days get the most traffic," or "what hours does the site peak" at all
  — one of the most natural questions "ask your AI agent instead of a
  dashboard" implies. All three use the same additive
  `interactionEvents`/`viewEvents` shape as `get_traffic_summary`, so
  an agent that already learned that vocabulary from
  `get_traffic_summary` doesn't need a second one here.
  `get_traffic_by_day_of_week` always returns all 7 days
  (Monday-first), `get_traffic_by_hour` always all 24 hours, both
  zero-filled — a quiet day/hour should show as a dip, not silently
  disappear, same reasoning as `get_daily_traffic`'s own zero-fill.
  Both inherit the same UTC-bucketing caveat already documented for
  `getTrafficByDay` in "Data model" above — hour-of-
  day is the most UTC-sensitive of the three, since a deployment whose
  visitors aren't near UTC can see a materially different "peak hour"
  than their actual local one.
- `get_new_vs_returning_visitors(period)` (`lib/audience.ts`'s
  `getNewVsReturningVisitors`) — of the visitors active in a period, how
  many are new (their all-time-earliest event falls inside it) versus
  returning (they were already active before it). Every mainstream
  analytics tool answers this and this project previously couldn't.
  Deliberately honest about a real limitation rather than hiding it:
  consentless visitor_ids rotate daily (see "Visitor identification"
  above) — a consentless visitor who comes back tomorrow gets a brand
  new hash and looks "new" again here, every time, by design. The tool's
  own description says so plainly, so an agent doesn't quote this as a
  precise retention number for a mostly-consentless deployment; it's
  fully meaningful for consentful visitors (a persistent cookie id) and
  for same-day returns either way.

### Distributing a single pullable image

Was "not planned", on the deployment model above: each client builds
their own image from their own clone (Coolify pulling from git). Half of
it has since been built, and the recommendation recorded here was
reversed, so both are worth writing down.

**What blocked it is gone.** Event definitions used to be TypeScript
compiled into the image (`packages/schema-registry/src/events/*.ts`),
which only worked because every deployment had its own source tree to
edit and rebuild. A shared image has no such tree. Events are now JSON
files read at startup from `EVENTS_PATH` on the volume, seeded from the
image — see "Event schemas as JSON files" above.

**Two options were weighed here, and this section recommended the one
that lost.** For the record:

1. *A declarative config format on the volume*, translated into Zod
   internally — simplest, but "strictly less powerful than
   `defineEvent`". This is what was built, and the cost was real and
   accepted: `EventType` stopped being a checked union, and a schema
   typo is caught at startup instead of at save time.
2. *Mounted plain `.js` files*, dynamically `import()`-ed, keeping the
   full Zod API. Recommended here on the grounds that it added no
   dependency and kept more validation power.

Option 2 was rejected in the end for a reason this section already
applied to the mounted-`.ts`-plus-bundler idea and should have applied
here too: the image would execute arbitrary user-supplied code at
startup rather than parsing data. Dropping the bundler removes a
dependency, not the arbitrary-code-execution. An analytics collector
reading its config off a mounted volume should not be a way to run
code, and "the operator owns the volume" is a weaker guarantee than it
sounds once a deployment is handed to a client.

Option 1 also turned out not to cost what was feared. The
`json_extract` limits that made `defineEvent` enforce flat scalars were
never Zod's power being used — the rule strings cover every built-in
prop exactly, and `list` was added afterwards, which `defineEvent` never
supported at all.

**What it became in practice** is not the `genug.config.json` sketched
here — one file with an `events` array — but one file per event, named
for the event. A single config file makes every event edit a whole-file
rewrite and puts unrelated settings in the blast radius of a typo; the
filename also carries the event name, so there is no `_name` key to
drift out of sync with the file holding it.

**Still missing for the pullable-image story**: publishing an image
anywhere (a CI step and a tagging decision), and a README setup path for
that route. The tagging decision has to include **arm64**:
`better-sqlite3` compiles per architecture, so an amd64-only image does
not start on an ARM VPS or a Pi, which is a real share of self-hosters. Until then this is possible rather than available. Env vars
(retention, `ALLOWED_ORIGIN`, secrets) stay env vars regardless, exactly
as this section originally said.

Note also that only custom *events* are freed by this. A custom MCP tool
or a changed cockpit is code, and still needs your own image.

### What a pullable image changes about being wrong

Five reviews were run against the finished product before publishing an
image — architecture, security, legal, UX, tests. Worth recording that
four of the five, working independently, said a version of the same
thing: the code is in good shape, and what breaks is the move from
"clone, edit, build" to "pull a tag". Every instruction that told an
operator to change a line of source is a dead end once there is no
source. Every behaviour we could previously fix by pushing a commit now
has to be right in a published artifact, or wrong in someone else's
deployment.

Five things came out of it, and they share that shape.

**`trust proxy` had to stop being a constant.** It was `1`,
unconditionally, with a README note telling Cloudflare users to edit the
line to `2`. Two reviewers arrived at it from opposite directions: from
a pulled image the line cannot be edited, and — worse — the quickstart
in our own README publishes the port with no proxy at all. There,
trusting one hop means believing an `X-Forwarded-For` header nobody
wrote but the sender, so `req.ip` becomes attacker-chosen. `req.ip` is
what all three rate limiters count, so the cockpit's ten-failures
lockout never fires and the password can be guessed at full speed. It is
now `TRUST_PROXY`, and it defaults to trusting **nobody**: the exposed
case is the safe one, and proxying is what you opt into. Unset and empty
are both spelled out rather than leaning on `Number("")` being `0` —
`TRUST_PROXY=` in a compose file means unset, and a coincidence that
lands on the right answer is not a reason.

**The edit route validated the wrong name.** `editEventFile` checked the
new name and not the current one, and the current one comes straight out
of the URL, which Express decodes before we see it. That made
`PUT /cockpit/events/..%2F..%2Fsomething` a path out of `EVENTS_PATH`,
and a rename would have unlinked what it found. Behind cockpit auth and
narrow in what it could reach, but there is no argument for taking an
unvalidated string and joining it to a directory. One check, one
regression test naming the traversal it prevents.

**A database can now be newer than the code reading it.** `runMigrations`
loops from the recorded `user_version` up to the number of migrations it
knows; if the recorded number is *higher*, the loop simply doesn't run.
That was unreachable when everyone ran their own HEAD. Pinning or
rolling back to an older tag is an ordinary thing to do with published
tags, and the failure was the silent kind — old code querying a newer
schema, no error. It now refuses to start and says which version the
file is at.

**Nothing said which build was running.** The MCP handshake advertised
`0.0.0`. Once strangers run tagged images, a bug report has to be able
to answer "which genug?", so `GENUG_VERSION` is stamped in at image
build time from the tag and read by the startup log and the handshake.
An unstamped build says `dev`, which is what a local one is. Deliberately
**not** on `/healthz`: that endpoint is public, and there is no reason to
hand a stranger the build number of a server they haven't authenticated
to.

**The visitor-text warning is one constant now, not a sentence to
remember.** `AGENTS.md` has always required a tool returning
visitor-supplied text to say so in its description, but five of them —
the page and referrer tools — didn't, and nothing noticed, because the
rule lived only in prose. The wording moved to `VISITOR_TEXT_CAVEAT` in
`mcp/shared.ts` and a test names the tools that must carry it. The list
is hand-maintained and that is the honest limit: nothing automated can
see what a tool's rows contain. But forgetting now fails in CI rather
than in an agent's answer.

What did *not* come out of it is worth recording too. No reviewer found
a problem with the data model, the query layer, the consent modes or the
failure behaviour. The architecture questions this journal spent the
most time on were not where the risk turned out to be.

The test suite was called adequate for release, with four gaps of the
"passes while wrong" kind, all now closed in
`integration/wiring.test.ts`: the page-view **stand-in** branch and the
throw beside it (both reachable only in a deployment that has edited its
event files — which is every deployment a published image creates), the
claim that a failed `reloadEvents()` is discarded whole while collection
carries on, the cockpit's rename route (no test anywhere issued a `PUT`,
and it is the route that moves stored rows), and `GET /cockpit/data`,
where one throw among ~16 queries blanks the page and an empty database
is what a fresh deploy sees first. Writing the rename one corrected an
assumption in passing: that route answers with the reload's counts, not
with `adoptedRows`.

### Smaller, worth naming

(Cockpit auth — `COCKPIT_PASSWORD` — and zero-JS click tracking via
`data-genug-on-click`/`data-genug-props` were both flagged
alongside these but judged small and low-risk enough to build right
away; see "Configuration" and "Client script embedding contract".)

- **REST API for external consumers.** MCP is for an AI agent asking
  natural-language questions — the wrong fit for a separately-built
  dashboard app or a BI platform pulling data programmatically, which
  want plain authenticated HTTP endpoints instead. When that need is
  real: a small `routes/api.ts` reusing the same `lib/` query functions
  the MCP tools already call, protected by its own bearer key
  (not `MCP_API_KEY` — different trust boundary, since this key would
  live in someone else's app/BI config, not an AI agent's). Plain REST,
  not GraphQL — the data isn't relational/nested enough to need
  flexible querying, and GraphQL would add a dependency and a schema
  layer this project doesn't otherwise need. Unlike MCP tools or the
  internal cockpit route (both freely reshapable), external consumers
  will hardcode against this, so it needs versioning discipline (e.g.
  `/api/v1/...`) from the day it ships.
- **Per-tool instruction pointers for other AI assistants.** The rules
  and recipes live in `AGENTS.md`, which is the cross-tool convention —
  Cursor, Codex and Aider read it on their own, and `CLAUDE.md` imports
  it so Claude Code does too. GitHub Copilot reads neither: it looks
  only at `.github/copilot-instructions.md`, so a Copilot user gets
  none of this. Windsurf (`.windsurfrules`) and Cline (`.clinerules`)
  are the same shape of gap.

  The fix is trivial — a three-line file per tool, each saying "read
  `AGENTS.md`" — so this is deferred on principle rather than effort.
  Every such file is a second copy of a pointer that can drift, and
  right now no deployment uses any of these tools, so they'd be
  maintenance for a reader who doesn't exist. Add one the day a real
  client turns up using that assistant, not before.
- **Slash commands for the three recipes.** `.claude/commands/`
  checked into the repo would let a deployer type `/add-event` instead
  of relying on their assistant choosing to open the right doc — the
  user asking for a file is deterministic, whereas a router table only
  makes it likely.

  Considered and deferred, for the same reason as the pointer files
  above: it's Claude Code-only, so it can't be *the* mechanism, only a
  shortcut layered on one that already works. `AGENTS.md`'s task table
  routes every assistant to the same three recipes, and the recipes
  are what carry the actual content. Revisit if the router turns out
  in practice to get skipped — a real customisation going wrong in a
  way the recipe would have prevented is the signal, not a hunch.
- ~~MCP client config recipe~~ Done: README's "Connecting an AI agent
  (MCP)" section has ready-made config snippets for Claude Code, Cursor,
  and Claude Desktop, so setup is copy-paste rather than "figure out
  MCP" from scratch. Claude Code and Cursor accept the streamable HTTP
  transport with a static Bearer header directly; Claude Desktop's
  remote-server support doesn't cover that (as of writing), so its
  snippet goes through a local `mcp-remote` stdio bridge instead — worth
  re-checking against Anthropic's current docs occasionally, since
  client-side MCP config support is a moving target.

(Zero-data guidance on `get_traffic_summary` — surfacing "no events
have ever been recorded" instead of an ambiguous zero — was flagged
alongside these but judged small and central enough to the AI-first
pitch to fix immediately rather than defer; see `mcp/tools.ts`.)
### Retention default: reversed, not because the disk filled up

~~Retention stays off by default~~ **Reversed, 2026-09-19.** The entry
above (under "Data lifecycle") named its own condition for revisiting:
"if a real deployment actually fills a disk." That condition has not
been met — nobody has reported one. The reason for reversing is a
different one, raised by the maintainer and checked against the
original reasoning rather than accepted on the strength of "safer
defaults are usually right": an unbounded default isn't only a risk of
a future problem, it's a standing Art. 5(1)(e) gap today, for every
deployment that never touches `RETENTION_DAYS` — which, for the
audience this project is actually built for (small companies
self-hosting, EU-context by default per this project's own working
agreement), is most of them. The original comparison weighed "full
disk" against "quiet data loss" and picked the recoverable one; it
didn't weigh the compliance gap unbounded-by-default leaves standing
for the deployer who never configures anything, which this project
treats seriously everywhere else in these docs (Art. 6, 11, 17, 21 all
get real discussion). That's the piece that changed the calculus, not
new evidence about disk usage.

**The real risk in making this change at all**, caught before shipping
rather than after: flipping the default without a way to say "no,
really, forever" would have relocated the exact harm the original entry
was written to prevent — silent data loss — from "every new deployment"
to "every existing deployment's next scheduled prune." `RETENTION_DAYS`
unset used to be how a deployer said "forever," deliberately or by
inertia; once unset means 425, that deployer has no value left to set
that means what they meant. Fixed by giving `-1` that meaning
(`parseRetentionDays` in `lib/retention.ts`) rather than adding a second
env var or a string sentinel — one type, one flag value, and it reads
naturally next to "a positive number of days." First tried `0` (a
common convention for "unlimited" elsewhere), and changed before
shipping when the maintainer pointed out the problem specific to a
*days* setting: "0 days" has a plausible, wrong, opposite reading —
keep nothing, not keep forever — and someone would only discover the
misreading once their data was already gone. `-1` has no plausible
reading as a day count at all, which is what makes it the safer
sentinel here: a reader can't confidently guess wrong, they have to
look it up. `0` is now refused with a message naming `-1` directly,
rather than falling into the generic invalid-value error.

Kept loud on both sides of the change, matching the standard the
original entry set: the startup log (`server/index.ts`) now fires
whenever `RETENTION_DAYS` is unset — the same condition as before, just
describing a different consequence — naming the number in effect and
the escape hatch in the same line, so `docker logs` after an upgrade
says exactly what changed and how to undo it. The cockpit's on-screen
line needed no code change at all: it already read the live value and
rendered whichever state was true.

**Treated as the most prominent Breaking item in this release** (see
CHANGELOG), not a Changed bullet among others — an existing deployment
upgrading with `RETENTION_DAYS` unset starts pruning years of its own
history on the very next startup, and `docs/operations.md`'s own
Restoring section already says there is no undo on the live database.
No data subject's rights are harmed by deleting data *earlier* than
Art. 5(1)(e) requires — that article is a ceiling, not a floor — but a
deployer's own business record disappearing without a very clear
warning is a real trust problem independent of GDPR, and freelance
analytics work for clients (see this project's own house rules) is
exactly the context where "what did traffic look like before the
redesign" six months from now is a real question someone will ask.

425 itself is unchanged — already the figure both `operations.md` and
`privacy.md` pointed deployers toward as what to configure by hand, and
already correctly caveated as CNIL-derived rather than a settled rule.
Shipping it as the default rather than only a recommendation carries
slightly more implied endorsement than telling someone to type it in
themselves; that's a real difference in weight, not just phrasing, and
is worth a second look from actual counsel on a deployment where the
exposure is anything but small — same caveat this file already holds
itself to everywhere else it touches § 25 TDDDG / Art. 6(1)(f).

**Changed on 2026-09-24: the default is now 396 days.** 425 days is
about 14 months, but every doc called it 13. The docs were right about
the intent, so the number moved. 396 is the same 13 months the consent
cookie already uses (`routes/events.ts`), so the cookie and the data it
identifies now end together.

Verified rather than assumed: `parseRetentionDays("-1")`, unset, and the
refusal of `0` (with its specific message) are each covered by a
dedicated test, an integration test seeds a 900-day-old row under
`RETENTION_DAYS=-1` and confirms it survives a real startup prune with
no "unset" log line, and mutation-checked — reverting the `-1` special
case fails exactly the tests naming it and nothing else.

### `get_deployment_context`: a tool alongside the resource, not instead of it

Reported by the maintainer: asking Claude.ai (a custom connector, Haiku
4.5) a question, the model said no deployment context was available —
it had never read `genug://deployment-context`, despite the file
holding real ground rules and history. Read directly with the generic
MCP resource tools from a different client (Claude Code), the resource
was fine: registered, discoverable, serving live content. The gap was
the client, not the server — MCP resources only reach a model that
either auto-attaches them or knows to call `resources/read` itself, and
that isn't universal, especially in simple connector UIs and with a
smaller model that won't go looking for a resource unprompted. Tools
don't have this problem; every client wires them into the normal
calling loop.

Fixed by adding `get_deployment_context` as a no-argument tool in
`server/mcp/context.ts` that returns exactly `readDeploymentContext()`'s
text — the same call the resource handler makes, so the two can't
drift. The resource stays registered too, for clients that do use it.
This overrides the "no separate tool, the resource already covers it"
call made for the schema registry above (line ~2141): that one was
about per-event *detail*, needed only once a specific query is already
underway; ground rules govern whether the agent answers *any* question
correctly, so they have to be reachable with no client resource support
at all. `genug://schema-registry` has the identical exposure gap —
`list_event_types` already covers the common case, so a `get_schema`
tool is a noted, deliberately deferred follow-up rather than done here.

Verified with a test that calls the new tool and asserts its text is
identical to the resource's.
