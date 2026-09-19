# Recipe: add an MCP tool

An MCP tool is one question your AI agent can ask about your data.
Before writing one, check you actually need it — the generic tools
already cover a lot:

| You want                                     | Already exists           |
| -------------------------------------------- | ------------------------ |
| Count one event, grouped by one of its props | `get_events_by_property` |
| Sum or average a numeric prop                | `get_property_sum`       |
| Any of the above, for one set of sessions    | the `segment` argument   |
| One event over time                          | `get_event_trend`        |
| An ordered multi-step conversion path        | `get_steps_funnel`       |
| Did one period's visitors come back later    | `get_cohort_return`      |

Those are registry-driven and work with any event you define, so
"revenue by product" or "signups by plan" needs no new code. The
`segment` argument every period-taking tool accepts narrows it to a set
of sessions — buyers of one product, visitors from one referrer or
campaign, one device type — so "where did buyers of X come from" is
`get_top_referrers` with a segment, not a tool of its own. Write a
tool when the **question needs logic the agent cannot assemble from
existing tools** — and if it is just "call an existing tool twice and
subtract", don't: the agent can do that itself. (A `compare_periods`
tool was built for exactly that and removed again.)

A tool is two pieces: a query function in `server/lib/`, and the tool
that exposes it in `server/mcp/`.

## 1. Write the query

Put it in the `server/lib/` module matching the kind of question —
`traffic.ts` (how much, when), `content.ts` (pages, referrers),
`events.ts` (what happened), `audience.ts` (who). A plain function over
the database:

```ts
// server/lib/events.ts
import { rank, type Ranked } from "./aggregate.js";
import { NO_SEGMENT, type SegmentClause } from "./segment.js";

export interface RepeatBuyer {
  visitorId: string;
  orders: number;
}

export function getRepeatBuyers(
  db: Database.Database,
  period: Period,
  limit: number,
  event: string,
  segment: SegmentClause = NO_SEGMENT,
): Ranked<RepeatBuyer> {
  const rows = db
    .prepare(
      `SELECT visitor_id AS visitorId, COUNT(*) AS orders
       FROM events
       WHERE event = @event AND ts BETWEEN @from AND @to${segment.sql}
       GROUP BY visitor_id
       HAVING orders > 1`,
    )
    .all({
      event,
      from: period.from,
      to: period.to,
      ...segment.params,
    }) as RepeatBuyer[];
  return rank(rows, (row) => row.orders, limit);
}
```

### Rules you cannot break

- **Bind every parameter** (`@name`), never interpolate a value into
  the SQL string. The one place dynamic JSON keys are needed,
  `json_extract('$.key')`, is guarded by `isValidPropertyKey` — use
  that guard, don't route around it.
- **Never add a tool that takes SQL**, however convenient. The whole
  design rests on the agent choosing between fixed, intent-shaped
  questions.
- **Never hardcode `"page_view"`.** Take the event name as a parameter
  and let the caller resolve it; a deployment may have renamed or
  dropped it.
- **Decide the unit before you write the `COUNT`.** A question about
  _what happened_ counts events — how many orders, how many views of a
  page. A question about _who was visiting_ counts sessions or
  visitors: referrers, devices, languages, "how many people did X".
  Counting events for the second kind lets one busy visitor outweigh
  many quiet ones, so the answer measures engagement while claiming to
  measure reach — and it stays plausible, which is why it survived two
  releases in `get_top_referrers` and `get_device_breakdown` before
  anyone noticed. One row per session is
  `GROUP BY session_id` with `MIN(ts)` and the column you want beside
  it; `rankSessionsBy` in `lib/aggregate.ts` counts and ranks the
  result. Name the field for its unit — `sessions`, `visitors`,
  `views` — never a bare `count`.
- **Take a `SegmentClause`** (`lib/segment.ts`) as the last parameter,
  defaulting to `NO_SEGMENT`, and paste `${segment.sql}` after your
  period condition with `...segment.params` in the bindings. That is
  all it takes for the tool's `segment` argument to work, and every
  period-taking query does it.
- **A ranked list returns `Ranked<T>`**, via `rank` (or `rankSessionsBy`)
  in `lib/aggregate.ts`: `{ items, groups, total }`. Not a bare array,
  and not `LIMIT` in SQL — hand `rank` every group so it can report how
  many there were and what they sum to. Ten rows with nothing saying
  "of four hundred" get reported as the whole; and a share needs a
  denominator in the same unit, which `total` is.
- Write a test beside the file (`events.test.ts`) covering the boundary
  your query cares about — the empty case and the one edge that would
  silently return a wrong number. For anything counted per session,
  make one session busy: that is the assertion that fails if someone
  changes it back. For anything about a session's shape (where it
  started or ended, how long it ran), scope it with
  `IN_SESSION_STARTED_IN_PERIOD` from `lib/sessionScope.ts` — the whole
  `WHERE` condition, time bound included, which is why it is one export
  and not two — and test a session that straddles the period's start: it
  belongs to the earlier period, not this one.

## 2. Expose it as a tool

In the matching `server/mcp/` module:

```ts
// server/mcp/events.ts
server.registerTool(
  "get_repeat_buyers",
  {
    description:
      "Get visitors who completed more than one order in a given time period, ranked by order count descending. Note that consentless visitors get a new visitor_id every day (see get_consent_breakdown), so a repeat purchase across two days is only visible for consentful visitors.",
    inputSchema: {
      ...periodInput,
      ...segmentInput,
      limit: limitInput("Max number of visitors to return"),
    },
  },
  async ({ from, to, segment, limit }) => {
    const resolved = resolveSegment(db, segment, { from, to });
    if ("error" in resolved) return resolved.error;
    return jsonContent(
      getRepeatBuyers(
        db,
        { from, to },
        limit,
        "order_completed",
        resolved.clause,
      ),
    );
  },
);
```

`segmentInput` and `resolveSegment` are the whole of segment support:
the argument's schema and description, and the validation that turns a
typo'd event or a stripped query parameter into an error naming the
valid options. Add `SEGMENT_HINT` to the description so the agent knows
the tool takes one.

For a ranked tool, end the description with `rankedShape("orders")`
from `./shared.js` — the one sentence every ranked tool uses to say
what `items`, `groups` and `total` mean.

### Rules you cannot break

- **Use `periodInput` from `./shared.js`** for any time period. It
  normalizes the bounds. If you write `z.string()` instead, a bare
  `"2026-01-01"` from the agent sorts below every real timestamp that
  day and the day vanishes from the result — a _wrong number reported
  confidently_, not an error. Use `limitInput` for limits and
  `jsonContent` for the return value.
- **The description is the tool's entire documentation.** The agent has
  nothing else. State what the number counts, what it excludes, and
  where it misleads — see how the built-in tools flag the consentless
  caveat. This is product surface, not a comment; write it last, when
  you know exactly what the query does.
- **An invalid argument returns an explanatory error, never an empty
  result.** If your tool takes an event or prop name, validate it
  against the registry first and list the valid options in the error. A
  typo must look like a typo, not like "no data" — the agent will
  report an empty result to a human as fact. Return it with
  `toolError`, which also sets the protocol's `isError` flag.

You get three things for free, and shouldn't re-implement them: the
tool appears in the cockpit's tool list, an inverted period (`from`
after `to`) is rejected before your handler runs, and period bounds
arrive already normalized.

## 3. If you need a new module

Only when your tools don't fit any existing group. Create
`server/lib/yourarea.ts` and `server/mcp/yourarea.ts`, export a
`ToolRegistrar` from the latter, and add it to the `toolModules` list
in `server/mcp/tools.ts`. That list is the only place that needs to
know a module exists.

## 4. Verify

```sh
npm run build && npm test && npm run lint
```

`server/mcp/tools.test.ts` exercises tools through the real MCP
protocol, and its cross-cutting checks are generated from the
registered tool list — so your new tool is covered automatically, and a
new required argument needs a fixture adding there.

Then ask your agent the question in plain language and check it picks
your tool and reads the result correctly. That last step is the one
nothing automated can do for you: no test can catch a _misleading
description_, which is this project's most likely failure mode.
