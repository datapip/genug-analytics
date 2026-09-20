# Connecting an AI agent

Point your AI client at `https://analytics.your-domain.com/mcp`,
authenticating with `Authorization: Bearer <MCP_API_KEY>`. Once
connected, just ask it things like "what were my top pages last week?"
or "where's my traffic coming from?" — it reads the schema-registry
resource first to see what events this deployment actually tracks, and
the deployment-context resource for how you want it to answer, then
calls the relevant tool itself.

## What you can ask

Every tool answers one question, and its description tells the agent
what the number means and where it misleads — so you ask in plain
language and the agent picks. The 31 tools cover:

- **How much, and when** — sessions, visitors and events for a period;
  per day, per weekday, per hour; one event's trend over time; how
  long sessions last and how many bounce.
- **Which pages, and where from** — top pages, entry and exit pages,
  the pages that lose the most visitors, referrers, and campaign
  parameters (`utm_campaign` and friends) on the entry page.
- **What happened** — every event type ranked, any event broken down
  by one of its own props, a numeric prop summed, and an ordered
  funnel of any events you name.
- **Who is visiting** — device types and browsers, languages, new
  versus returning, consent mix, and whether one period's visitors
  came back in a later one.
- **Is tracking working** — the latest raw events, rejected requests
  with the reason, bot traffic, and events stranded by a rename.

Every tool that takes a period also takes a **segment**: a list of
conditions that narrow the answer to a set of sessions — those that
contained an event (with a prop value), came from a referrer, entered
on a page or campaign parameter, or used a device, browser or
language. That is how "where did the buyers of product X come from"
is one call: top referrers, segmented to sessions with
`order_completed` where `product_id` is X. There is no raw-SQL tool
and no row export, on purpose; see "MCP tool design" in
[decisions.md](decisions.md) for why.

## Telling the agent how to answer

Alongside the schema registry, the agent reads a **deployment-context**
resource: a markdown document you write, at `ground-rules.md` in
`CONTEXT_PATH` (default `/data/context`). It holds instructions rather
than data — ask instead of guessing, say whether a number counts
sessions or visitors, be careful with small samples. A sensible default
is written there on first start; edit it, or empty it to have none.
Edits apply on the next question, with no restart.

Keep it to how you want the agent to _behave_. Facts about what a
number means already live in each tool's own description, and a claim
written in both places will eventually disagree with itself.

Two things to know: text in this file is treated as instruction the
agent can act on, unlike the URLs and referrers visitors supply, which
tools explicitly flag as data only. And on a `READ_ONLY` deployment the
MCP key is public, so anyone holding it can read this file — don't put
anything private in it there.

### Telling it what happened

The same document carries a **history**: things that happened to the
site or its tracking, so the agent can explain a change in the numbers
instead of guessing at it. It lives in `history.json` beside the ground
rules, and is a list of entries:

```json
[
  { "from": "2026-06-15", "note": "New product launch, with a big ad push." },
  {
    "from": "2026-01-01",
    "to": "2026-02-02",
    "note": "Tracking was broken sitewide — a deploy dropped the script tag."
  }
]
```

`from` and `note` are required; `to` only when the entry covers a range.
Dates are `YYYY-MM-DD` and have to be real days. Each note is shown to
the agent on one line, so line breaks inside one become spaces — keep an
entry to a sentence or two and write a second entry rather than a
paragraph. An entry that doesn't
fit is skipped and named in the document, so a typo costs that entry
rather than the file. A file that isn't valid JSON is reported as
unreadable — deliberately, so it can never be mistaken for "nothing
happened".

The agent is told that an empty history means nothing was written down,
not that nothing occurred, so it won't cite one as evidence.

It reaches the model vendor the same way ground rules do (see [What
leaves your server when you ask](#what-leaves-your-server-when-you-ask)
below), and it is free text about your own business rather than a
sentence about how to answer — more likely to have a name in it
("refunded Jane Doe's order") than a ground rule ever is. The same
caution applies: on a `READ_ONLY` deployment the key is public, so don't
put anything private in a note.

You don't have to edit the file by hand. Tell the agent what happened
and it can write the entry for you with `add_history_note` — "the
checkout was down all of Tuesday" becomes a dated line the next
session reads. It adds entries only; changing or removing one is an
edit to `history.json` on the server. The agent is told to record only
what **you** said, never something it read in a tool result: URLs and
prop values come from visitors, and this file is the one place text is
read back as instruction.

Three kinds of entry write themselves, marked **Recorded
automatically**: renaming an event, deleting one, and Reset events.
Those are the only cockpit actions that can change your numbers — each
leaves already collected rows under a name nothing asks about any more
— so the agent finds that cause in the same place it looks for yours,
instead of reporting a drop on the 12th as though the website had
changed. Creating an event or fixing its wording changes no number and
writes nothing.

Both forms ask **why**, optionally, and put what you type on the same
line as `Reason given: …`. It is the one moment anyone knows the answer;
a week later the rename is a mystery to everyone including you. Leave it
empty and the line is still written, just without the reason.

Two tools write. `delete_visitor_data` previews before it deletes and
needs an explicit confirmation — see
[Erasure](operations.md#deletion-and-erasure) — and `add_history_note`
appends to the history above. A deployment started with `READ_ONLY=true`
registers neither, which is the mode for a key you mean to publish (see
[Configuration](deploying.md#configuration)).

`/mcp` accepts 60 calls a minute per address before answering 429, and
one JSON-RPC message per request — a batched array is refused with 400.
Both are far above what an agent working through a question needs, and
exist so a public key cannot be used to keep the server busy.

## What leaves your server when you ask

Worth being clear about, because it is the one place the self-hosted
story has an edge. Genug stores everything on your own machine and
sends it nowhere on its own. But an MCP client is something else's
client: when you ask a question, the tool results it fetches go into
that model's context, which for a hosted assistant means they are sent
to that vendor's API. So do the two resources described above — the
schema registry and the deployment-context document (ground rules and
history) — since a client reads both before it calls anything.

Most tools return aggregates — counts, rankings, breakdowns.
`get_recent_events` is the exception: it returns raw rows, including
URLs and whatever your events put in `props`. Query strings are already
filtered down to campaign parameters before anything is stored (see
[privacy.md](privacy.md)), so the usual accidents are covered, but your
own event props are yours to keep clean. If your deployment holds data
you would not hand to a third party, that is the tool to think about.
`READ_ONLY=true` unregisters it along with every writing tool, so a
deployment whose key is meant to be public — a demo, for instance —
never hands out raw rows through it. On a deployment that isn't
`READ_ONLY`, there is no separate setting that turns just this one
tool off: keeping the writing tools while dropping only this one takes
a build of your own, a fork of `server/mcp/diagnostics.ts` rather than
of the project.

For a client's deployment in the EU this is a processor relationship
with the model vendor, not a technicality: you need a data-processing
agreement with them and a valid basis for the transfer, and the
recipient belongs in the tracked site's privacy policy. An
EU-hosted or locally-run model avoids the transfer question entirely.
None of this is legal advice — if the data is a client's, get it
checked.

## Claude Code / Cursor

Both support a remote HTTP server with a custom header directly. Add to
`.mcp.json` (Claude Code, project-scoped) or `.cursor/mcp.json`
(Cursor):

```json
{
  "mcpServers": {
    "genug": {
      "type": "http",
      "url": "https://analytics.your-domain.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_API_KEY" }
    }
  }
}
```

Claude Code also has a one-line CLI form:

```sh
claude mcp add --transport http genug https://analytics.your-domain.com/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

## Claude Desktop

Claude Desktop's remote-server support doesn't cover a static Bearer
header directly (as of writing) — it needs a local stdio bridge via
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) instead:

```json
{
  "mcpServers": {
    "genug": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://analytics.your-domain.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_API_KEY"
      ]
    }
  }
}
```

MCP client config support changes over time — check each client's
current docs if a snippet above doesn't work.
