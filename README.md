# Genug Analytics

[![CI](https://github.com/datapip/genug-analytics/actions/workflows/ci.yml/badge.svg)](https://github.com/datapip/genug-analytics/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Self-hosted web analytics you query by asking an AI agent, instead of
reading a dashboard.**

A script tag on your site sends events to a server you run. Then you
ask — in Claude, Cursor, or any MCP client — and the agent answers from
your own data:

> **You:** Did anything unusual happen on the site last week?
>
> **Agent:** Interaction events were up about 35% last Tuesday — almost
> entirely `outbound_link_click` on your GitHub link, not more page
> views. Worth checking what pointed there that day.

_Genug_ is German for _enough_: just enough analytics to answer your
questions, and nothing to operate beyond one process and one file.

**Status:** alpha. Running in production on the maintainer's own site;
not yet used elsewhere. The numbers are tested and the privacy model is
written down, but the shape of things may still change before 1.0 —
what changed between versions is in [CHANGELOG.md](CHANGELOG.md).

## Why

- **Ask, don't read.** 31 MCP tools, each answering one question
  a site owner actually asks — top pages, where traffic comes from,
  which campaign converted, whether last week's visitors came back.
  Every tool can be narrowed to a segment of sessions, so "where did
  the buyers of product X come from" is one call, not a dashboard
  filter you have to build. If you want a chart, ask the agent for one.
- **Radically small.** One Node process, one SQLite file, no analytics
  platform to run. Your own events are one JSON file each — no
  migration, no rebuild, live the moment you save.
- **Privacy by architecture.** No cookie by default: the visitor id is
  a daily-rotating hash of a truncated address and the User-Agent, and
  neither is ever stored. Query strings are filtered before they reach
  the database. A working opt-out is built in. Consent switches on a
  first-party cookie, and nothing else changes.

A small cockpit is there for when you want to look rather than ask:

![The Genug Analytics cockpit in dark mode: an Overview band with session, event, rejected and bot counts, then a 30-day traffic trend chart and cards ranking top pages, top referrers and device types](docs/assets/cockpit.png)

## Quick start

The full walk-through with a screenshot is
[docs/getting-started.md](docs/getting-started.md). The short version:

1. **Pick a hostname on a subdomain of the site you track**, such as
   `data.your-domain.com`. The consent cookie is host-only, so a
   different domain silently degrades consentful tracking. Details in
   [deploying](docs/deploying.md#the-hostname).
2. **Run it.** On a fresh Ubuntu server, one command installs Docker,
   puts Caddy in front for HTTPS, and starts it — asking only for the
   hostname, the tracked site's origin, and a cockpit password:

   ```sh
   curl -fsSL https://genug-analytics.com/install.sh | sudo bash
   ```

   Already on Coolify, building from source, or want to run `docker run`
   and a reverse proxy by hand instead? All three are in
   [deploying](docs/deploying.md#installing).

3. **Put the script on your site**, early in `<head>`:

   ```html
   <script>
     window.genugAnalyticsConfig = { enableAutoPageTracking: true };
   </script>
   <script defer src="https://data.your-domain.com/client.js"></script>
   ```

4. **Watch the first event arrive** at `/cockpit`, with the password
   you set. If nothing shows, the rejected counter says why.
5. **Connect your agent.** For Claude Code it is one line; other
   clients are in [connecting an agent](docs/mcp.md).

   ```sh
   claude mcp add --transport http genug https://data.your-domain.com/mcp \
     --header "Authorization: Bearer YOUR_MCP_API_KEY"
   ```

   Then ask: _"What were my top pages this week, and where did that
   traffic come from?"_

Before going live on an EU site, two things the software cannot do for
you: name what you collect in your privacy notice, and state your
retention period there (it defaults to 425 days — a real period, not
forever — but your notice still has to say so). Both are laid out in
[privacy](docs/privacy.md).

## What you can ask

The agent reads the schema registry first, so it knows what your
deployment tracks, then picks the tool. The tools cover:

| Question                     | Answered by                                                   |
| ---------------------------- | ------------------------------------------------------------- |
| How much traffic, and when?  | Summary, per day / weekday / hour, one event's trend          |
| Which pages, and where from? | Top, entry, exit and bounce pages; referrers; campaign params |
| What happened?               | Events ranked, broken down by any prop, summed, funnelled     |
| Who is visiting?             | Devices and browsers, languages, new vs returning, cohorts    |
| Is tracking working?         | Recent raw events, rejections with reasons, bot traffic       |
| … for one set of sessions?   | The `segment` argument on every tool above                    |

What each number means, what it excludes and where it misleads is in
every tool's description — that is the documentation the agent reads,
and it is written to be argued with. There is deliberately no raw-SQL
tool and no row export. More in [docs/mcp.md](docs/mcp.md), including
what leaves your server when a hosted model answers.

## Tracking your own events

Three events come built in: page views, outbound link clicks and file
downloads, each behind its own opt-in flag. Anything else is yours to
define — one JSON file, or the cockpit's form — and to send:

```js
window.genugAnalytics.track("order_completed", {
  order_total: 49.9,
  order_currency: "EUR",
});
```

```html
<button data-genug-on-click="cta_click" data-genug-props='{"plan":"pro"}'>
  Upgrade
</button>
```

Props are validated against your schema on arrival; a mistyped one
shows up in the cockpit's rejected counter rather than vanishing.
Single-page apps, consent wiring, idempotency keys and the limits on
what you can send are in [docs/client.md](docs/client.md); adding an
event end to end is [a recipe](docs/recipe-add-event.md).

## Privacy, in one paragraph

Every event is one row: the event name, a server-assigned visitor and
session id, a UTC timestamp, the URL and referrer with query strings
filtered down to campaign parameters, the device type and browser the
User-Agent classified to, the visitor's language, the consent mode,
and the props your event declares. No raw address, no User-Agent
string, no profile. In consentless mode nothing is written to the
visitor's device except the opt-out flag, if they ask for it. Whether
that lets you run without a banner is your decision to make with your
own counsel; [docs/privacy.md](docs/privacy.md) sets out what Genug
does, what stays yours to do, and where the argument is unsettled.

## Make it yours

You run your own copy, so change it. Three recipes are written to be
followed end to end, by you or by an AI assistant working in this repo:

- [Add a tracked event](docs/recipe-add-event.md)
- [Add an MCP tool](docs/recipe-add-mcp-tool.md) — check first; the
  generic tools plus a segment already answer most questions
- [Change the cockpit](docs/recipe-change-cockpit.md)

An AI coding assistant pointed at this repo picks up [AGENTS.md](AGENTS.md):
a short set of rules that keep a customisation from producing numbers
that are plausible while wrong. The reasoning behind every rule is in
[docs/decisions.md](docs/decisions.md).

## Operating it

- **Retention** defaults to 425 days, a defensible starting point (see
  [operations](docs/operations.md#retention) for the reasoning) — set
  `RETENTION_DAYS=-1` to keep everything instead, or a different number
  of days to choose your own period.
- **Backups** are on by default: a daily consistent snapshot on the
  same volume, seven days kept. Copying them off the host is your job.
- **Erasure** goes through the agent's one write tool, which previews
  before it deletes. A consentless visitor cannot be looked up, by
  design — read that section before promising anyone erasure.
- **Health** is `GET /healthz`.
- **Capacity**, measured rather than guessed: about 2,300 events a
  second in Docker behind a reverse proxy, and 0.4 KB stored per event.
  Writing does not care how large the database is; reading does. A
  2 vCPU / 2 GB VPS is enough and 4 GB is headroom —
  `scripts/load-events.mjs` re-runs the test on your own hardware.

Capacity, retention, backups, restore, erasure and migrations: [docs/operations.md](docs/operations.md).

## Project

```
packages/client/           The browser snippet — a classic script, no imports
packages/schema-registry/  The event envelope's schema; one JSON file per event
server/                    One process: /events collector, /mcp, /cockpit
  lib/                     The query layer, one module per kind of question
  mcp/                     The tools, grouped to match lib/
apps/cockpit/              Static HTML, CSS and JS — no build step
docs/                      Guides, recipes, the design journal
```

```sh
npm install
npm run build && npm test && npm run lint
```

Runtime dependencies: `express`, `better-sqlite3`, `zod`, and the MCP
SDK. Tests use `node:test`, colocated with the code they test. A
hands-on end-to-end check against a real second site is in
[docs/manual-testing.md](docs/manual-testing.md); cutting a release is
[docs/releasing.md](docs/releasing.md).

## License

MIT — see [LICENSE](LICENSE). Self-host it, change it, redeploy it;
that is the point of the deployment model.
