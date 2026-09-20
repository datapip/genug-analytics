# Changelog

What changed for someone running Genug, newest first. Not a commit log
— `git log` is that, and it is better at it.

While the version starts with `0.`, breaking changes are expected and
are marked **Breaking**. See [docs/releasing.md](docs/releasing.md) for
how a version is cut.

## 0.6.0 — 2026-09-20

**Added**

- The cockpit can now edit ground rules and add business context
  ("About this site") for the AI agent, and add dated history notes —
  completing the deployment-context feature. Both prose fields are
  capped at 32KB and show a live byte counter; history notes stay
  append-only from the cockpit (editing or removing one is still a
  file edit on the volume). All three writes are disabled under
  `READ_ONLY`, but ground rules and business context stay readable
  even then.

**Changed**

- On a deployment that isn't `READ_ONLY`, holding just
  `COCKPIT_PASSWORD` is now enough to read ground rules and the full
  history log through the cockpit — previously that needed
  `MCP_API_KEY` or shell access to the volume. If you've handed the
  cockpit password to someone without the MCP key, they can now read
  (and, unless `READ_ONLY`, write) what your AI agent is told. See the
  `COCKPIT_PASSWORD` row in [docs/deploying.md](docs/deploying.md).
- `READ_ONLY=true` now also unregisters `get_recent_events`, the one
  MCP tool that returns raw event rows (URLs, props, referrer) instead
  of an aggregate. It writes nothing, so this wasn't covered by the
  existing "closes every write" behaviour — but a deployment whose key
  is meant to be public, which is what `READ_ONLY` is for, shouldn't
  hand out raw visitor rows through it either. If you rely on this
  tool from a `READ_ONLY` deployment, it's gone; every other
  diagnostic tool (`get_schema_errors`, `get_bot_activity`, etc.) is
  unaffected.

**Fixed**

- Saving ground rules or business context text right at the 32KB cap
  could push the request body past the router's old 64KB limit once
  JSON-escaping was counted, surfacing a raw parser error instead of
  the friendly one. Both routes now get 128KB of body headroom.

## 0.5.0 — 2026-09-19

**Breaking**

- **`RETENTION_DAYS` now defaults to 425 days (~13 months) instead of
  forever.** If you're running a deployment where `RETENTION_DAYS` has
  never been set, upgrading to this version starts pruning events older
  than 425 days on the very next startup — with no undo. **Before you
  upgrade**, decide: if you want to keep everything, set
  `RETENTION_DAYS=-1` first — that is now the explicit way to say
  "forever," since omitting the setting no longer means that. If 425
  days (or some other period) is fine, no action needed; the server
  logs which case applied at every startup where the value is unset, so
  `docker logs` after upgrading tells you what happened either way.
  Why: an unset retention period is a standing GDPR compliance gap for
  every deployment that never configures it, which is most of them —
  see [docs/decisions.md](docs/decisions.md) under "Data lifecycle" for
  the full reasoning, including why this reverses an earlier decision
  on record.

**Added**

- A tab icon for the cockpit and its sign-in page.

**Changed**

- Four small cleanups from a code-review pass, no behavior change:
  the cockpit's CSRF-header check was duplicated across three routes,
  now one shared check; two validation-message strings and the
  New-event/Add-prop schemas were each duplicated, now defined once;
  and the cockpit's four write handlers (save, add a prop, delete,
  create) shared a hand-copied ~20-line submit sequence, now a single
  helper each calls with a few lines of its own.
- The cockpit's light theme is dimmed a step — page and card
  backgrounds were close enough to pure white (`#fcfcfd`/`#ffffff`)
  that cards read as blending into the page rather than sitting on it.
  Text contrast is unaffected; dark mode is untouched.

**Fixed**

- A failed save, add-prop, delete or create in the cockpit is now
  announced to a screen reader and moves focus to the error message.
  Disabling the button (to stop a double-submit) drops focus to
  nothing, so previously an error was silent unless you were already
  looking at the right paragraph — the same failure class as a past
  fix to the delete-confirmation's focus order. Found during this
  release's review, not by lint or the test suite; confirmed live.

## 0.4.0 — 2026-09-19

**Breaking**

- The two HTML tagging attributes were renamed to say when they fire:
  `data-genug-event` → `data-genug-on-click`, and `data-genug-load` →
  `data-genug-on-load`. Nothing else changed about how either works.
  Update the attributes on your site before taking this version, or the
  tagged elements stop sending. `data-genug-props` is unchanged.
- **The cockpit signs in on a page instead of using HTTP Basic Auth.**
  Same `COCKPIT_PASSWORD`, nothing to reconfigure — but `curl -u` no
  longer reaches `/cockpit`, and any script or uptime check using it
  needs the two-step form in
  [deploying.md](docs/deploying.md#signing-in-to-the-cockpit). Your
  browser will ask for the password once more; its saved Basic Auth
  entry for this site is now unused. The session cookie is `Secure`, so
  a cockpit served over plain http on a LAN address (not `localhost`)
  will not stay signed in — the sign-in page says so when it happens.

**Added**

- **A history log.** `history.json`, beside the ground rules, holding
  dated notes about what happened to the site or its tracking — an
  outage, a campaign launch, a redesign. The agent reads them as part of
  the same document, so it can explain a change in the numbers instead
  of guessing at a cause. An entry that doesn't fit is skipped and named
  rather than dropping the file, and an empty log is reported as "nothing
  written down", never as "nothing happened". The daily backup now
  copies this folder too. You can also just tell the agent: the new
  `add_history_note` tool writes the entry for you, and says back what
  it wrote. It only adds — changing or removing an entry is still an
  edit to the file — and a `READ_ONLY` deployment doesn't register it.
- **Ground rules for the agent.** A markdown file at `ground-rules.md`
  in the new `CONTEXT_PATH` (default `/data/context`) holding
  instructions the agent reads before answering — ask instead of
  guessing, name the unit, be careful with small samples. Seeded with a
  sensible default on first start, then yours to edit or empty; edits
  apply on the next question with no restart. Served as one
  `genug://deployment-context` resource. On a `READ_ONLY` deployment
  the MCP key is public, so this text is too.
- **The cockpit writes its own history entries.** Renaming an event,
  deleting one and Reset events each add a dated line to the history
  log, marked "Recorded automatically". Those three are the only
  cockpit actions that can move your numbers — they leave already
  collected rows under a name nothing asks about any more — so when you
  ask why a chart dropped, the agent finds that cause in the same place
  it reads your own notes. Creating an event or fixing its wording
  writes nothing. Both forms ask why, optionally — what you type is
  added to the same line as "Reason given: …".
- **A Log out button in the cockpit**, which Basic Auth never had —
  and sessions that expire after 12 hours instead of lasting until the
  browser is closed. Logging out signs out every browser: there is one
  password, so there is one session, and the reason to press it is that
  a copy is somewhere it shouldn't be. Changing `COCKPIT_PASSWORD` does
  the same thing.
- An event can be flagged `"_conversion": true` to mark it as a
  business goal (a signup, a purchase, a newsletter subscribe). Any
  number of events may carry it. Reported by `list_event_types`, the
  schema-registry resource, and a cockpit badge; no query branches on
  it yet.

**Changed**

- The cockpit's new-event form now says that an event's name and
  description are what the AI agent reads to understand it, and shows a
  concrete good/bad pair.
- The README says alpha, and what that means: running in production on
  the maintainer's own site, not yet used elsewhere.
- **The cockpit is about twice as fast on a large database.** The
  queries behind it looked at every page view ever recorded to work out
  which visits belong to the week on screen; now they skip anything
  older than the period. Same numbers — at five million events the page
  went from 2.4 s to 1.2 s, and asking the agent where buyers came from
  from 3.0 s to 1.1 s. Nothing changes below a million or so events,
  where none of this was noticeable.
- **[docs/operations.md](docs/operations.md) now states measured
  capacity** instead of saying nothing: about 2,900 events a second
  collected, about 0.4 KB stored per event, and what the cockpit page
  costs as the database grows (21 ms at 100,000 events, 1.2 s at five
  million). It also answers what to rent: 2 vCPUs and 4 GB are
  comfortable with the whole stack included — measured in Docker behind
  a reverse proxy sharing those two cores, at 2,276 events a second and
  about 430 MB of RAM — and 1 GB still works, the container surviving a
  128 MB limit. Measured with `scripts/load-events.mjs`, which ships so
  you can re-run it on your own hardware.
- The recipe for adding an event covers modelling a cart: line items as
  one event each rather than a nested list, including the idempotency
  key collision that silently drops rows if you key them all on the
  order id.
- `docs/client.md` notes that a tagged non-interactive element (a
  `<div>` rather than a `<button>` or `<a>`) never fires for a
  keyboard-only visitor.
- [docs/mcp.md](docs/mcp.md) names the schema registry and
  deployment-context resources (ground rules and history) as also
  reaching the model vendor, alongside tool results, and restates the
  "don't put anything private in it" caution for history notes
  specifically — they're free text about your own business, more likely
  to carry a name than a ground rule is.

**Fixed**

- Opening the delete-event confirmation moves focus straight to the
  optional reason field, so a screen reader announced that field and
  its hint but skipped the warning paragraph above it — the one part of
  the confirmation explaining what the delete actually does. Now
  announced too.

## 0.3.0 — 2026-09-15

**Added**

- **Segments.** Every tool that takes a time period now also takes a
  `segment`, so "where did the buyers of product X come from" is one
  call rather than a tool of its own.
- **`READ_ONLY` mode**, which leaves every writing tool unregistered —
  for a deployment whose API key is public.
- A request limit on `/mcp` (60 calls a minute per address), on top of
  the existing failed-attempt lockout.
- The cockpit can add an optional prop to a live event, and delete an
  event — including a role-tagged one.
- A **Reset events** button in the cockpit's danger zone, which clears
  the events directory and re-seeds the built-ins.
- A getting-started page, and the README split into topic guides.

**Changed**

- **Ranked results are now `{ items, groups, total }`**, and every
  count is named for its unit (`sessions`, `visitors`, `views`,
  `events`) rather than a bare `count`.
- **Referrers, devices and languages count sessions or visitors, not
  events.** Counted per event, one desktop visitor reading twenty pages
  outweighed ten phone visitors reading two — the number measured
  engagement while reading as reach.
- Session-shaped queries are scoped to sessions that _started_ in the
  period.
- The stored envelope keeps the device type and browser the User-Agent
  classified to, never the header itself.
- Self-referrals are excluded from top referrers.
- `PRAGMA synchronous = NORMAL`.
- The cockpit was reorganised into labelled sections with jump links and
  accordions, made readable on a phone, and shows the running version,
  the consent share, and what was rejected rather than only how many.

**Fixed**

- **Every abuse counter keys on a block, not a full address.** Keying on
  the whole address bounded nothing on IPv6, where one line is delegated
  a whole block — including the cockpit and `/mcp` lockouts.
- Two ways the limiter key misread an address (a `host:port` value from
  a proxy, and an IPv6 address written with an embedded dotted quad).

## 0.2.0 — 2026-09-13

**Added**

- **Events are JSON files on the volume** (`EVENTS_PATH`), one per
  event, seeded from the image the first time the directory is empty.
  Adding an event needs no rebuild and no database change.
- **Schema changes apply without a restart** — drop a file in and press
  Reload in the cockpit.
- The cockpit can create an event, edit an event's words, and rename
  one, offering to carry the stored rows across.
- **List props** (`string.list`, `number.list`), up to 50 values.
- **A real opt-out**, and orphaned-event reporting: rows whose event
  type is no longer registered still count toward totals but match no
  registry-driven query, so they are surfaced rather than left to make
  the numbers quietly wrong.
- The image is built and published to `ghcr.io/datapip/genug-analytics`
  on every `v*` tag, and a cockpit danger zone that resets the database.

**Changed**

- **The consentless visitor hash is built from a truncated address**
  (IPv4 /24, IPv6 /48), not the whole one.
- The client script sends a _role_ (`pageView`, `outboundClick`,
  `fileDownload`) for the three events it fires itself, never a literal
  name — so renaming one costs no rejected events.
- Event and prop names must be lowercase; the client folds the casing it
  sends to match.
- Comments are stripped from the shipped `client.js`.

## 0.1.0 — 2026-09-11

First tagged release: the `POST /events` collector, the MCP endpoint and
its tools, the cockpit, one SQLite file, and a `Dockerfile` to run it
all as one process. No image was published under this tag — that
arrived in 0.2.0.
