# Connecting an AI agent

Point your AI client at `https://data.your-domain.com/mcp` with the
header `Authorization: Bearer <MCP_API_KEY>`. Then ask, for example,
"what were my top pages last week?". The agent reads which events you
track and how you want answers, then picks the tool.

## What you can ask

Each tool answers one question, and its description tells the agent
what the number means and where it misleads. The 33 tools cover:

- **How much, and when** — sessions, visitors and events for a period;
  per day, per weekday, per hour; one event's trend over time; how
  long sessions last and how many bounce; and whether a rise or drop is
  bigger than the site's usual week-to-week noise.
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
  with the reason, bot traffic, whether events are still arriving, and
  events stranded by a rename.

Every tool that takes a period also takes a **segment**, which narrows
the answer to some sessions: those with an event or prop value, a
referrer, an entry page or campaign, a device, browser or language. So
"where did the buyers of product X come from" is one question. There
is no raw-SQL tool and no row export, on purpose.

## Telling the agent how to answer

Before answering, the agent reads a **deployment context** that you
write. It is three files in `CONTEXT_PATH` (default `/data/context`).
Edits apply on the next question.

- **`ground-rules.md`**: how to answer. Ask instead of guessing, say
  whether a number is sessions or visitors, be careful with small
  samples. A default is written on first start. Keep it to behaviour;
  what a number means is already in each tool's description.
- **`about.md`**: what the site or business is for. It starts empty.
  Write it from the cockpit or by hand.
- **`history.json`**: what happened to the site, so the agent can
  explain a change instead of guessing. See below.

The agent treats this text as instruction, unlike visitor-supplied URLs
and props, which it treats as data. On a `READ_ONLY` deployment the
key is public, so these files are too: keep anything private out.

### Telling it what happened

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

`from` and `note` are required, `to` is for a range. Dates are
`YYYY-MM-DD`. Keep a note to a sentence or two. A bad entry is skipped
and named; a file that isn't valid JSON is reported as unreadable, so
it is never mistaken for "nothing happened".

You don't have to edit the file. Tell the agent what happened and it
adds an entry with `add_history_note`. It only adds; to change or
remove an entry, edit the file. It records only what **you** said,
never something read from a tool result.

Renaming, deleting or resetting events in the cockpit adds an entry by
itself, marked **Recorded automatically**, because those can change
your numbers. The cockpit asks for an optional reason and adds it to
the entry.

### Limits and writing tools

Two tools write: `delete_visitor_data`, which previews and asks for
confirmation ([erasure](operations.md#deletion-and-erasure)), and
`add_history_note`. `READ_ONLY=true` removes both.

`/mcp` accepts 60 calls a minute per address with the right key, and
one JSON-RPC message per request. Both are far above what an agent
needs. Calls without the right key have their own budget of 10, so a
stranger can't use up yours.

## What leaves your server when you ask

Genug sends nothing anywhere on its own. But when you ask a question,
the tool results go into the model's context. For a hosted assistant,
that means they are sent to the vendor. So are the event definitions
and the deployment context, which the agent reads first.

Most tools return aggregates: counts, rankings, breakdowns.
`get_recent_events` is the exception. It returns raw rows, including
URLs and whatever your events put in `props`. One answer is capped at
64,000 characters of JSON, about 100 ordinary rows. Query strings are
filtered before anything is stored (see [privacy](privacy.md#what-gets-stored)),
which keeps most personal data out, but not all: a `utm_*` value or a
prop can still contain something personal. If your deployment holds
data you wouldn't hand to a third party, this is the tool to think
about. `READ_ONLY=true` removes it.

Whether you need a data-processing agreement with the model vendor,
and what to say in your privacy policy about it, is a question for your
lawyer. Genug can't answer it for you.

## Setting up your client

Client setups change over time. If a snippet doesn't work, check that
client's current docs.

### Claude Code / Cursor

Both support a remote HTTP server with a custom header directly. Add to
`.mcp.json` (Claude Code, project-scoped) or `.cursor/mcp.json`
(Cursor):

```json
{
  "mcpServers": {
    "genug": {
      "type": "http",
      "url": "https://data.your-domain.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_API_KEY" }
    }
  }
}
```

Claude Code also has a one-line CLI form:

```sh
claude mcp add --transport http genug https://data.your-domain.com/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

### VS Code

VS Code (with GitHub Copilot's agent mode) supports a remote HTTP
server with a custom header too, but its config uses a `servers` key
rather than `mcpServers`. Add to `.vscode/mcp.json` in the workspace,
or run **MCP: Open User Configuration** for every workspace:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "genug-key",
      "description": "Genug MCP API key",
      "password": true
    }
  ],
  "servers": {
    "genug": {
      "type": "http",
      "url": "https://data.your-domain.com/mcp",
      "headers": { "Authorization": "Bearer ${input:genug-key}" }
    }
  }
}
```

The `inputs` entry makes VS Code ask for the key once and store it
itself, so a `.vscode/mcp.json` you commit doesn't carry it.

### Claude Desktop

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
        "https://data.your-domain.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_API_KEY"
      ]
    }
  }
}
```

### claude.ai

Add a custom connector in claude.ai's settings, with the URL
`https://data.your-domain.com/mcp` and an `Authorization` header of
`Bearer YOUR_MCP_API_KEY`. claude.ai connects from Anthropic's servers,
so your server must be reachable over HTTPS. Where the header field
sits depends on your plan, so check claude.ai's current help pages.

Check with your lawyer whether your plan's terms are enough for your data before you
connect (see [what leaves your server](#what-leaves-your-server-when-you-ask)).

Then try the [weekly digest](digest.md) as a first prompt.
