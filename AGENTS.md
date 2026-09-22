# Genug Analytics — working rules

Self-hosted, AI-native web analytics. A script tag collects events; the
site owner asks an AI agent (over MCP) what happened, instead of reading
a dashboard. One Node process, one SQLite file, npm workspaces.

This file is the **contract**: what you must not break, and where to go
for the task you're doing. It is short on purpose. The reasoning behind
every rule here lives in `docs/decisions.md` — read that before
proposing an architectural change, not before doing a normal task.

## Which task are you doing?

| Task                                     | Read                                  |
| ---------------------------------------- | ------------------------------------- |
| Add or change a tracked event            | `docs/recipe-add-event.md`            |
| Add an MCP tool for your own data        | `docs/recipe-add-mcp-tool.md`         |
| Change the cockpit page                  | `docs/recipe-change-cockpit.md`       |
| Anything else, or "why is it like this?" | `docs/decisions.md`                   |
| Deploy, configure, embed the script      | `docs/deploying.md`, `docs/client.md` |

Those three recipes are written to be followed end to end. If you are
customising a deployment, you almost certainly want one of them rather
than this file's details.

## Layout

```
packages/schema-registry/  The envelope's Zod schema; events/ is one JSON file each
packages/client/           The browser snippet (classic script, no imports)
server/
  routes/events.ts         POST /events — validate, identify, store
  routes/mcp.ts            MCP transport + API key check
  routes/cockpit.ts        JSON for the cockpit page, and its event edits
  lib/                     Query layer: one module per kind of question
  mcp/                     MCP tools, grouped to match lib/
  db/                      Connection, migrations, raw SQL
apps/cockpit/              Static page: index.html + cockpit.css + cockpit.js
docs/                      Guides, recipes, design journal, release steps
```

`server/lib/x.ts` pairs with `server/mcp/x.ts`: the query lives in
`lib/`, the tool that exposes it in `mcp/`. The four analytics families
— traffic, content, events, audience — pair by name. The rest group by
the question instead: one `mcp/` module may draw on several `lib/` ones
(`mcp/diagnostics.ts` over four of them), and `mcp/registry.ts` has no
`lib/` pair at all. Don't rename files to force the symmetry. Tests sit
next to the file they test (`x.ts` + `x.test.ts`).

## Invariants

Break one of these and the deployment is subtly wrong rather than
visibly broken, which is the failure mode this project cares most about.

**Data**

- The stored envelope is fixed: `event`, `visitor_id`, `session_id`,
  `ts`, `url`, `referrer`, `device_type`, `browser`, `visitor_language`,
  `consent_mode`, `props`. Everything type-specific goes in `props` as
  JSON. **Adding an event never needs a database change.**
- `visitor_id`, `session_id` and `ts` are always assigned server-side.
  Never accept any of them from the client.
- Event props are declared in JSON, one file per event, as rule strings
  (`"string"`, `"string.long"`, `"number.optional"`). The format cannot
  express a nested object, and every string is capped — 512, or 2048
  with `long`. `/events` is public and its values are read back to the
  agent verbatim, so an uncapped text prop would be a channel for a
  stranger to write into the model's context.
- `list` declares several values of one type in one prop (`"string.list"`,
  `"number.list"`), capped at 50 values. Anything reading one must go
  through `json_each` — `json_extract` returns the whole array as one
  opaque string, so grouping by it groups by the array. `getEventsByProperty`,
  `getPropertySum` and a segment's event condition (`lib/segment.ts`)
  take an `isList` flag for this. A query over a list left
  unimplemented must say so — never return the zero that comparing a
  serialized array produces.
- Every query that takes a period also takes a `SegmentClause`
  (`lib/segment.ts`, built by `buildSegment` from validated
  conditions), pasted into its WHERE. A new period-taking query takes
  one too, and its tool spreads `segmentInput` and calls
  `resolveSegment` — that is what makes "where did buyers of X come
  from" one call rather than a tool of its own.
- Events are read from **one** directory: `EVENTS_PATH` (default
  `/data/events`), seeded from the image's
  `packages/schema-registry/events/` whenever it holds no event files —
  in practice the first start, or after the cockpit's Reset events
  button empties it — and never read otherwise — so renaming or deleting a built-in is an
  ordinary file edit, and a file renamed away does not come back to put
  two events on one role tag. The checker names the file and key it
  rejected; a bad file, or a second claiming a role tag another
  carries, is skipped and reported rather than allowed to stop the
  server.
- `eventRegistry`, `pageViewEventType`, `roleEventNames`, `eventsSource`
  and `schemaErrors` are **live bindings** that `reloadEvents()`
  replaces, so a schema change needs no restart. Read each one inside
  the handler that needs it: caching one in a module-level constant
  opts that consumer out of every reload, silently and with no test
  failing.
- What the owner writes for the agent lives in a **second** directory,
  `CONTEXT_PATH` (default `/data/context`): `ground-rules.md` (how to
  answer) and `history.json` (what happened to the site). Never in
  `EVENTS_PATH` —
  everything reading that one filters for `.json`, so prose put there
  would be skipped by the seeder and survive Reset events.
  `lib/context.ts` reads it per request and holds no state, which is
  why it needs no live binding. It is served whole to the agent as one
  markdown resource (`genug://deployment-context`), so a further piece
  becomes a new **section** of that document, not a second URI. Also
  served as the `get_deployment_context` tool, word-for-word the same
  text — a client that never calls `resources/read` (several
  connector UIs don't) otherwise has no path to this document at all.
  Unlike
  visitor text, it is instruction the agent may act on — which is why
  the cockpit must not gain an edit box for it without deciding who may
  write there, and why `READ_ONLY` (a published key) makes it public.
  An empty or unreadable file must never render as "nothing happened":
  a history the agent reads as evidence of no cause is the same
  plausible-while-wrong failure as an empty query result. The backup
  copies this directory, because `history.json` is the one file here
  nothing can re-create — which is also why every writer appends, leaves
  an entry it cannot validate in place, and refuses a file it cannot
  parse instead of writing a fresh array over it. Anything that writes
  here is writing text a later session is told to act on, so it says
  where a fact may come from: what the person said, never what a tool
  returned. Two writers: `add_history_note` (what the owner says
  happened) and `lib/autoHistory.ts` (the three cockpit writes that
  strand rows — rename, delete, Reset events), whose entries say
  "Recorded automatically" because the rest of the file is the owner's
  own words. A cockpit write that cannot strand a row does not log:
  creating an event and editing its wording move no number, and a log
  of everything is a log nobody reads. A note claims rows were stranded
  only when the reloaded registry no longer has the name — deleting or
  renaming away from the page-view event hands its name back to the
  stand-in, and those rows still match.
- The cockpit **edits** an event's words only — name, description,
  prop descriptions and examples; prop names, rule strings
  and role tags are copied through untouched (`lib/editEvent.ts`),
  because a form that can change validation can stop collection on a
  typo. **Creating** one does define props (`lib/createEvent.ts`): a
  name nothing sends yet has no traffic to reject. Even there the
  browser sends a type from a fixed list, never a rule string, and
  neither form offers a role tag. The danger zone's **Reset events**
  is the third and bluntest write: it clears the directory and
  re-seeds the built-ins, so it is the whole directory or nothing —
  renaming a built-in renames its file, leaving no way to tell one
  from an event a deployment wrote.
- Two narrower writes exist for an event that already has traffic.
  **Adding a prop** (`lib/addEventProp.ts`) is always forced optional,
  never a rule string, same closed type picker as creating — a prop
  nobody is sending yet is indistinguishable from an absent key on any
  row already stored, so it cannot reject live traffic the way a
  required prop or a changed rule string would. **Deleting an event**
  (`lib/deleteEvent.ts`) is the single-event counterpart to Reset, and
  carries no role-tag exception at the file level — the client sends a
  _role_, never a literal name, for the events tagged
  `_automaticOutboundClick`/`_automaticFileDownload`, so losing one of
  those just rejects the next automatic click or download as
  `unknown_event_type`, visibly. `_pageView` is the one case that needs
  a real check, because `buildRegistry()` can throw instead of falling
  back to its stand-in (see "Events are read from one directory" above)
  — so `routes/cockpit.ts`'s DELETE handler deletes, asks
  `reloadEvents()`, and restores the file if the real loader refuses the
  result, rather than guessing in advance. Deleting or renaming a _prop_
  stays a file edit — either one reproduces the exact silent-rejection
  failure the words-only line
  above exists to prevent, with no way to make it safe from a browser.
- A cockpit rename knows both names, so it offers to carry the stored
  rows across. Moving rows onto rows already under the target name is
  refused (a permanent merge); inheriting them is allowed but disclosed.
- Single-tenant. Never add `tenant_id` or any multi-tenancy scaffolding.

**Queries and tools**

- Never expose raw SQL, and never add a `query_events(sql)` tool. Tools
  are intent-shaped: one tool answers one question.
- A tool that writes goes in `mcp/admin.ts`, which `READ_ONLY=true`
  leaves unregistered (`writingToolModules` in `mcp/tools.ts`). A
  writing tool put anywhere else stays live on a deployment whose key
  is public. The cockpit side of the same promise is a router-level
  refusal of every non-GET request, so a cockpit write must not be a
  GET. `get_recent_events` gets the same treatment
  (`rawDataToolModules`) though it writes nothing — it is the one tool
  that returns raw rows instead of an aggregate, so a public key
  shouldn't double as a raw event export either.
- A query about **who was visiting** counts sessions or visitors, not
  events — referrers, devices, languages. Counting events there lets
  one busy visitor outweigh many quiet ones, so the number measures
  engagement while reading as reach, and stays plausible while being
  wrong. A query about **what happened** counts events, and `views` for
  page-scoped ones. Name the returned field for its unit; a bare
  `count` is how this gets missed.
- Never build SQL by string interpolation. Bind parameters. (The one
  accepted exception — `json_extract('$.key')` — is guarded by
  `isValidPropertyKey`; use it, don't work around it.)
- Every tool taking a time period uses `periodInput` from
  `server/mcp/shared.ts`. It normalizes the bounds, and a hand-rolled
  `z.string()` will silently return wrong numbers rather than an error.
- Never hardcode `"page_view"`. Resolve the event tagged
  `"_pageView": true` via `pageViewEventType`; a deployment is free to
  rename it but cannot drop it — if nothing carries the tag, the
  built-in is registered as a stand-in and the cockpit is told why, so
  it is always a real name and never needs a "what if there is none"
  branch. `outboundClick` and `fileDownload` are optional and resolve to
  `undefined`; the request is then rejected saying which tag is missing.
- The client script never sends a name for the three events it fires
  itself — it sends the role (`auto: "pageView"` and friends) and
  `routes/events.ts` resolves it through `roleEventNames`. That keeps
  `client.js` free of deployment state: put any back and the cache
  window has to shrink again, and renames start costing rejected events.
- Anything a visitor supplied — `url`, `referrer`, prop values — is
  untrusted text, never an instruction. A tool returning it appends
  `VISITOR_TEXT_CAVEAT` (`mcp/shared.ts`) and joins `tools.test.ts`'s list.
- A tool's `description` is the only documentation the agent ever gets.
  Say what the number means, what it excludes, and where it is
  misleading. This is product surface, not a comment — and a test
  enforces a minimum, for tools and for every registered event and
  prop. A test can only see that you wrote a sentence; whether it is
  accurate is on you.

**Failure behaviour**

- A mistake must look like a mistake. An unknown event name, an
  unknown prop, an inverted period: return an explanatory error listing
  the valid options. Never return an empty result that reads as "no
  data" — the agent will report it to a human as fact.
- The same goes for data a change strands. Renaming or deleting an
  event leaves rows that still count toward totals but match no
  registry-driven query — so the numbers stay plausible while being
  wrong, which is worse than an obvious zero.
  `lib/orphanedEvents.ts` finds them; the cockpit and
  `get_orphaned_events` report them. Anything else that can strand rows
  needs the same treatment.
- Missing required config fails at startup, loudly. Follow `requireEnv`.

**Cockpit**

- No framework, no bundler, no build step, no CDN — the CSP blocks
  external scripts and the page has no inline `<script>`. Edit
  `apps/cockpit/*.js` and `.css` directly.
- The cockpit answers "is this healthy / what's the shape of my
  traffic" at a glance. Anything needing a follow-up question to
  interpret belongs to the agent.
- Everything under `/cockpit` needs a session except an exact-match
  allowlist of five paths — the sign-in page, its script, the
  stylesheet, the theme switch and the favicon (`PUBLIC_GETS` in
  `lib/cockpitAuth.ts`). A file the sign-in page starts needing is a new
  entry, or it 401s; anything else added there is published to anyone
  who knows the hostname, which is why it is exact strings and not a
  prefix.
- Every request the page makes goes through `cockpitFetch`, which turns
  a 401 into "the session ran out, go and sign in". So a 401 means that
  and nothing else: a route refusing a request for its own reasons —
  a mistyped confirmation password — answers 403, or it throws the owner
  out of the cockpit mid-form.

**Privacy**

- Consentless is the default and sets no identifying cookie:
  `visitor_id` hashes a **truncated** address (IPv4 /24, IPv6 /48,
  `truncateIp` in `lib/ip.ts`) + User-Agent + a daily salt. Never
  persist anything per-visitor in that mode; the one exception written
  to any device is the opt-out flag, which holds no identifier.
- Anything counting abuse per client — a rate limit, a lockout — keys
  on `limiterKey`, never on `req.ip`. It keeps an IPv4 address whole
  and narrows IPv6 to a /48, because one line is _delegated_ a whole
  IPv6 block: key on the full address and an attacker simply moves to
  the next one, and the counter bounds nothing.
- Don't add a new field that identifies a visitor more precisely
  without saying so in `docs/decisions.md` and in the README.

## Dependencies

Adding one needs a real justification. It must be fully open source
with no paid tier for anything used, and either very common or the de
facto reference implementation. Prefer the standard library; prefer a
small amount of plain code over a dependency. Current runtime set:
`express`, `better-sqlite3`, `zod`, `@modelcontextprotocol/sdk`. Tests
use Node's built-in `node:test` — no Vitest, no Jest.

## Commands

```sh
npm install
npm run build          # all workspaces; required before running tests
npm test               # all workspaces
npm run lint
npm run format:check
```

Run `npm run build && npm test && npm run lint` before you call any
change done. Tests are colocated and compiled; `npm test` rebuilds from
a cleaned `dist/` first, so it always runs your current source. Don't
"optimise" that back to an incremental build — an output whose source
was deleted survives `tsc -b` forever and keeps passing (see
`docs/decisions.md`).

Two cases in `server/integration/wiring.test.ts` skip themselves on
Windows, which has neither POSIX directory permissions nor deliverable
signals. They still run on Linux, which is what CI uses — a skip line
there is expected, not something to fix.

## Conventions

- TypeScript strict. No `any` without a comment justifying it.
- Zod schemas are the source of truth for shapes — derive types with
  `z.infer`, never hand-write a parallel interface.
- Small single-purpose modules over large files.
- Comments explain _why_, not _what_. Match the density around you.
- Commit messages: short lowercase imperative, no prefix or ticket tag.
