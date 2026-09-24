import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eventRegistry } from "@genug/schema-registry";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { createMcpServer, getToolManifest } from "./tools.js";
import { VISITOR_TEXT_CAVEAT } from "./shared.js";

// These drive the tools through the real MCP protocol rather than
// calling the handlers directly, using the SDK's own linked in-memory
// transport — no HTTP, no subprocess, nothing mocked. That matters
// because most of what this layer does happens *around* the handler:
// input-schema validation, the Zod period transform, and the
// registerTool wrapper that adds the manifest entry and the inverted-
// period guard. Calling a handler directly would skip all three.
//
// The lib/ modules already test the metric maths; these tests are about
// the tool layer's own job — validation, gating, and the shape it
// promises the agent.
async function connect(seed?: (db: Database.Database) => void) {
  const db = new Database(":memory:");
  migrate(db);
  seed?.(db);

  const server = createMcpServer(db);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-test", version: "1" });
  await client.connect(clientTransport);
  return { db, client };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

// Validation failures come back as an isError result whose text is a
// plain message rather than JSON, so they need the raw result.
async function callRaw(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: result.isError === true, text: result.content[0]!.text };
}

function eventCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number })
    .c;
}

// A resource's contents are a text-or-blob union; ours is always text.
function resourceText(contents: unknown[]): string {
  const first = contents[0] as { text?: unknown };
  assert.equal(typeof first.text, "string", "expected a text resource");
  return first.text as string;
}

// Deliberately bare dates, not full timestamps: that's what an LLM
// actually emits, and normalizing it is the whole point of periodInput.
const PERIOD = { from: "2026-01-01", to: "2026-01-01" };

function pageView(overrides: Record<string, unknown> = {}) {
  return {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: "2026-01-01T10:00:00.000Z",
    url: "https://example.com/pricing",
    props: {},
    ...overrides,
  };
}

// Arguments a tool needs beyond the period, so the generated tests below
// reach the handler instead of failing schema validation first. Kept
// honest by the coverage test that follows.
const EXTRA_ARGS: Record<string, Record<string, unknown>> = {
  get_events_by_property: { event: "page_view", property: "page_title" },
  get_property_sum: { event: "page_view", property: "page_title" },
  get_steps_funnel: { steps: ["page_view", "file_download"] },
  get_event_trend: { event: "page_view" },
  get_top_entry_params: { param: "utm_campaign" },
};

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

async function listTools(client: Client): Promise<ListedTool[]> {
  const { tools } = await client.listTools();
  return tools as ListedTool[];
}

function takesPeriod(tool: ListedTool): boolean {
  const properties = tool.inputSchema?.properties ?? {};
  return "from" in properties && "to" in properties;
}

// --- the contract every tool owes the agent ---

// A tool's description is the only documentation the agent ever gets:
// it decides which tool to call, and how to read the result, from this
// text alone. So the bar is a real sentence, not a label — a deployment
// that adds `description: "orders"` has written a tool the agent will
// misuse. Length is a crude proxy, but it's the only part of "is this
// description any good" a test can check; whether it's *accurate* stays
// a human review job, and is this project's likeliest failure mode.
const MIN_TOOL_DESCRIPTION = 40;

test("every registered tool describes itself to the agent", async () => {
  const { client } = await connect();
  const inadequate = (await listTools(client))
    .filter(
      (tool) => (tool.description?.trim().length ?? 0) < MIN_TOOL_DESCRIPTION,
    )
    .map((tool) => tool.name);

  assert.deepEqual(
    inadequate,
    [],
    "these tools need a description saying what the number means, what it excludes, and where it misleads",
  );
  await client.close();
});

// The cockpit's tool overview is built from this manifest, so a drift
// between it and what's actually registered would show the deployer a
// list that isn't real.
test("the manifest matches what is actually registered", async () => {
  const { db, client } = await connect();
  const listed = (await listTools(client)).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
  }));

  assert.deepEqual(
    [...getToolManifest(db)].sort((a, b) => a.name.localeCompare(b.name)),
    [...listed].sort((a, b) => a.name.localeCompare(b.name)),
  );
  await client.close();
});

// The read-only promise is that nothing behind a public key can write.
// Checked through the protocol, because "not registered" is the whole
// mechanism: a tool that is absent from tools/list cannot be called at
// all, whereas a flag inside its handler could be forgotten by the
// next writing tool.
test("a read-only server registers no writing tool, and its manifest says so", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const server = createMcpServer(db, { readOnly: true });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-test", version: "1" });
  await client.connect(clientTransport);

  const names = (await listTools(client)).map((tool) => tool.name);
  assert.ok(!names.includes("delete_visitor_data"));
  // Writes text the deployment-context document tells every later
  // session to act on, so it is at least as public-key-sensitive as the
  // delete above.
  assert.ok(!names.includes("add_history_note"));
  // Writes nothing, but hands back raw rows instead of an aggregate —
  // a public key shouldn't double as a raw event export either.
  assert.ok(!names.includes("get_recent_events"));
  assert.ok(names.includes("get_traffic_summary"), "reads are still there");
  // The other diagnostics stay: they answer "is tracking working",
  // which a read-only demo deployment still needs.
  assert.ok(names.includes("get_schema_errors"));
  assert.ok(names.includes("get_bot_activity"));

  const manifest = getToolManifest(db, { readOnly: true }).map((t) => t.name);
  assert.deepEqual([...manifest].sort(), [...names].sort());
  // And the writable manifest is a different list, not the same cache.
  const writableNames = getToolManifest(db).map((t) => t.name);
  assert.ok(writableNames.includes("delete_visitor_data"));
  assert.ok(writableNames.includes("get_recent_events"));
  await client.close();
});

// Without this, a new tool with a new required argument would make the
// generated tests below pass for the wrong reason — failing validation
// long before reaching the behaviour they mean to check.
test("test fixtures cover every tool's required arguments", async () => {
  const { client } = await connect();
  const uncovered: string[] = [];

  // Scoped to the tools the generated tests actually call. A
  // non-period tool (delete_visitor_data) needs its own fixture in its
  // own test, not one here.
  for (const tool of (await listTools(client)).filter(takesPeriod)) {
    const supplied = new Set([
      "from",
      "to",
      ...Object.keys(EXTRA_ARGS[tool.name] ?? {}),
    ]);
    for (const required of tool.inputSchema?.required ?? []) {
      if (!supplied.has(required)) uncovered.push(`${tool.name}.${required}`);
    }
  }

  assert.deepEqual(
    uncovered,
    [],
    "add these to EXTRA_ARGS so the generated tests still exercise the handler",
  );
  await client.close();
});

// The generated tests below call every tool whose input has `from` and
// `to`, for real, with no arrangement made for what it might do. That is
// safe only while that shape means "a read over a period". A writing
// tool that declared the same pair would be swept in and actually run —
// against whatever path the environment points at on the machine running
// the suite, which is the hazard, not the wasted call. Derived from the
// read-only registration split rather than a list of names, so it holds
// for the next writing tool too.
test("no writing tool declares a query period", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const readOnlyNames = new Set(
    getToolManifest(db, { readOnly: true }).map((tool) => tool.name),
  );

  const { client } = await connect();
  const writing = (await listTools(client)).filter(
    (tool) => !readOnlyNames.has(tool.name),
  );
  assert.ok(writing.length > 0, "sanity: something writes");

  assert.deepEqual(
    writing.filter(takesPeriod).map((tool) => tool.name),
    [],
    "name these arguments something other than from/to — see guardPeriod",
  );
  await client.close();
});

// Generated from the tool list rather than a hand-kept one, so a new
// period-taking tool is covered the day it's written — the same
// reasoning the guard itself uses to find them.
test("every period-taking tool rejects an inverted period", async () => {
  const { client } = await connect();
  const periodTools = (await listTools(client)).filter(takesPeriod);
  assert.ok(periodTools.length > 15, "sanity: most tools take a period");

  for (const tool of periodTools) {
    const result = await call(client, tool.name, {
      from: "2026-01-05",
      to: "2026-01-01",
      ...EXTRA_ARGS[tool.name],
    });
    assert.match(
      String(result.error),
      /inverted/,
      `${tool.name} accepted a backwards period`,
    );
  }
  await client.close();
});

test("a tool with no period is left alone by that guard", async () => {
  const { client } = await connect((db) => insertEvent(db, pageView()));
  const events = (await call(client, "get_recent_events", {
    limit: 5,
  })) as unknown as { event: string }[];

  assert.equal(events.length, 1);
  assert.equal(events[0]!.event, "page_view");
  await client.close();
});

// The bug that started all of this: SQLite compares ts as a string, so a
// bare "2026-01-01" as `to` sorts below every real timestamp that day
// and silently drops it. A wrong number an agent reports confidently is
// worse than an error, so this is the regression test that matters most
// in this file.
test("a bare `to` date covers the whole day, not midnight", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView({ ts: "2026-01-01T23:59:59.500Z" }));
  });

  const summary = await call(client, "get_traffic_summary", PERIOD);
  assert.equal(summary.viewEvents, 1, "the last event of the day was dropped");
  await client.close();
});

// Reaches the agent as an ordinary tool error it can read and retry —
// not a thrown protocol exception, and not a silently wrong number.
test("an unparseable date comes back as a readable validation error", async () => {
  const { client } = await connect();
  const result = await callRaw(client, "get_traffic_summary", {
    from: "last tuesday",
    to: "2026-01-01",
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /Invalid ISO8601 date/);
  assert.match(result.text, /2026-09-30/, "shows the shape it wants");
  await client.close();
});

// One entry per calendar day, so the response grows with the period.
test("get_traffic_by_day refuses a period longer than its cap", async () => {
  const { client } = await connect();
  const result = await call(client, "get_traffic_by_day", {
    from: "0001-01-01",
    to: "9999-12-31",
  });

  assert.match(String(result.error), /731/);
  assert.match(String(result.error), /get_traffic_summary/, "offers a way out");
  await client.close();
});

// --- registry-driven validation: a typo should look like a typo ---

test("get_events_by_property names the valid events for an unknown one", async () => {
  const { client } = await connect();
  const result = await call(client, "get_events_by_property", {
    event: "produt_added_to_cart",
    property: "x",
    ...PERIOD,
  });

  assert.match(String(result.error), /Unknown event type/);
  assert.match(String(result.error), /page_view/, "lists the real options");
  await client.close();
});

test("get_events_by_property names the valid props for an undeclared one", async () => {
  const { client } = await connect();
  const result = await call(client, "get_events_by_property", {
    event: "page_view",
    property: "nope",
    ...PERIOD,
  });

  assert.match(String(result.error), /Unknown prop "nope"/);
  assert.match(String(result.error), /page_title/);
  await client.close();
});

// SUM over a text prop would return 0 — which reads as "no revenue"
// rather than "wrong prop".
test("get_property_sum refuses a non-numeric prop and points elsewhere", async () => {
  const { client } = await connect();
  const result = await call(client, "get_property_sum", {
    event: "page_view",
    property: "page_title",
    ...PERIOD,
  });

  assert.match(String(result.error), /isn't numeric/);
  assert.match(String(result.error), /get_events_by_property/);
  await client.close();
});

// The protocol's own flag for a failed call. Without it a client shows
// the refusal as an ordinary result and a model can't tell it from data.
test("a tool error is flagged as isError at the protocol level", async () => {
  const { client } = await connect();
  const result = await callRaw(client, "get_events_by_property", {
    event: "nope",
    property: "x",
    ...PERIOD,
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /Unknown event type/);
  await client.close();
});

// --- segments: every validation failure names what was wrong ---

test("a segment condition with a property but no value is refused", async () => {
  const { client } = await connect();
  const result = await call(client, "get_traffic_summary", {
    segment: [{ event: "page_view", property: "page_title" }],
    ...PERIOD,
  });

  assert.match(String(result.error), /must be given together/);
  await client.close();
});

test("a segment condition must name exactly one dimension", async () => {
  const { client } = await connect();
  const none = await call(client, "get_traffic_summary", {
    segment: [{}],
    ...PERIOD,
  });
  assert.match(String(none.error), /no dimension/);
  assert.match(String(none.error), /entryParam/, "lists the dimensions");

  const two = await call(client, "get_traffic_summary", {
    segment: [{ deviceType: "mobile", browser: "Chrome" }],
    ...PERIOD,
  });
  assert.match(String(two.error), /2 dimensions/);
  await client.close();
});

// Shapes that pass the schema but could only ever match nothing.
test("a segment refuses a URL as a host, a slashless path, a non-locale language and a repeated dimension", async () => {
  const { client } = await connect();
  const cases: [Record<string, unknown>[], RegExp][] = [
    [[{ referrerHost: "https://google.com" }], /not a URL/],
    [[{ referrerHost: "" }], /not a URL or an empty string/],
    [[{ entryPath: "pricing" }], /starting with "\/"/],
    [[{ entryPath: "/pricing?x=1" }], /without query string/],
    [[{ language: "" }], /locale tag/],
    [[{ language: "e_" }], /locale tag/],
    [
      [{ deviceType: "mobile" }, { deviceType: "tablet" }],
      /repeats deviceType/,
    ],
    [
      [
        { entryParam: "utm_source", entryParamValue: "a" },
        { entryParam: "UTM_SOURCE", entryParamValue: "b" },
      ],
      /repeats entryParam/,
    ],
  ];
  for (const [segment, expected] of cases) {
    const result = await call(client, "get_traffic_summary", {
      segment,
      ...PERIOD,
    });
    assert.match(String(result.error), expected, JSON.stringify(segment));
  }
  await client.close();
});

test("a segment on a query parameter ingestion strips is refused, naming the kept ones", async () => {
  const { client } = await connect();
  const result = await call(client, "get_traffic_summary", {
    segment: [{ entryParam: "email", entryParamValue: "x" }],
    ...PERIOD,
  });

  assert.match(String(result.error), /not kept/);
  assert.match(String(result.error), /utm_campaign/);
  await client.close();
});

test("a segment narrows a ranked tool", async () => {
  const { client } = await connect((db) => {
    insertEvent(
      db,
      pageView({
        sessionId: "s1",
        deviceType: "mobile",
        url: "https://example.com/m",
      }),
    );
    insertEvent(
      db,
      pageView({
        sessionId: "s2",
        deviceType: "desktop",
        url: "https://example.com/d",
      }),
    );
  });
  const pages = await call(client, "get_top_pages", {
    segment: [{ deviceType: "mobile" }],
    ...PERIOD,
  });

  assert.deepEqual(pages, {
    items: [{ path: "/m", views: 1 }],
    groups: 1,
    total: 1,
  });
  await client.close();
});

// The test above proves one tool. This one catches a handler that
// declares `segment` and then never passes resolved.clause on — the lib
// queries all default to NO_SEGMENT, so that compiles and returns
// whole-site numbers. Mobile is one quiet session; desktop is two busier
// ones with different consent, entry, referrer and a download, so every
// tool's answer changes when narrowed to mobile.
test("every segment-taking tool gives a different answer for a segment", async () => {
  const { client } = await connect((db) => {
    insertEvent(
      db,
      pageView({
        visitorId: "m1",
        sessionId: "m1",
        deviceType: "mobile",
        browser: "Safari",
        visitorLanguage: "de",
        url: "https://example.com/m?utm_campaign=m",
        referrer: "https://www.google.com/",
        props: { page_title: "M", document_language: "de" },
      }),
    );
    for (const id of ["d1", "d2"]) {
      insertEvent(
        db,
        pageView({
          visitorId: id,
          sessionId: id,
          deviceType: "desktop",
          browser: "Chrome",
          visitorLanguage: "en",
          consentMode: "consentful",
          ts: "2026-01-01T14:00:00.000Z",
          url: "https://example.com/d?utm_campaign=d",
          referrer: "https://bing.com/",
          props: { page_title: "D", document_language: "en" },
        }),
      );
      insertEvent(
        db,
        pageView({
          visitorId: id,
          sessionId: id,
          deviceType: "desktop",
          browser: "Chrome",
          visitorLanguage: "en",
          consentMode: "consentful",
          event: "file_download",
          ts: "2026-01-01T14:05:00.000Z",
          url: "https://example.com/d",
          props: {
            file_url: "https://example.com/a.pdf",
            file_extension: "pdf",
            link_text: "a",
          },
        }),
      );
    }
  });

  // No built-in event has a numeric prop to sum; its segment splice is
  // tested in lib/events.test.ts instead.
  const skipped = new Set(["get_property_sum"]);
  const segmented = (await listTools(client)).filter(
    (tool) =>
      takesPeriod(tool) &&
      "segment" in tool.inputSchema!.properties! &&
      !skipped.has(tool.name),
  );
  assert.ok(segmented.length > 20, "expected most tools to take a segment");
  for (const tool of segmented) {
    const args = { ...PERIOD, ...EXTRA_ARGS[tool.name] };
    const whole = await callRaw(client, tool.name, args);
    const mobile = await callRaw(client, tool.name, {
      ...args,
      segment: [{ deviceType: "mobile" }],
    });
    assert.equal(whole.isError, false, `${tool.name}: ${whole.text}`);
    assert.equal(mobile.isError, false, `${tool.name}: ${mobile.text}`);
    assert.notEqual(
      mobile.text,
      whole.text,
      `${tool.name} ignored its segment`,
    );
  }
  await client.close();
});

// Pins the exempt list in mcp/tools.ts from both sides: a new tool
// cannot hide there, and a renamed one cannot leave a stale entry that
// the startup check then silently never needs.
test("only the tools over other tables take a period without a segment", async () => {
  const { client } = await connect();
  const unsegmented = (await listTools(client))
    .filter(
      (tool) =>
        takesPeriod(tool) && !("segment" in tool.inputSchema!.properties!),
    )
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(unsegmented, [
    "get_bot_activity",
    "get_top_rejected_events",
  ]);
  await client.close();
});

test("get_top_entry_params refuses a parameter ingestion strips", async () => {
  const { client } = await connect();
  const result = await call(client, "get_top_entry_params", {
    param: "email",
    ...PERIOD,
  });
  assert.match(String(result.error), /not kept/);
  await client.close();
});

test("get_cohort_return checks both periods and their order", async () => {
  const { client } = await connect();
  const inverted = await call(client, "get_cohort_return", {
    cohortFrom: "2026-01-07",
    cohortTo: "2026-01-01",
    returnFrom: "2026-01-08",
    returnTo: "2026-01-14",
  });
  assert.match(String(inverted.error), /inverted/);

  const overlapping = await call(client, "get_cohort_return", {
    cohortFrom: "2026-01-01",
    cohortTo: "2026-01-07",
    returnFrom: "2026-01-07",
    returnTo: "2026-01-14",
  });
  assert.match(String(overlapping.error), /must start after/);

  const ok = await call(client, "get_cohort_return", {
    cohortFrom: "2026-01-01",
    cohortTo: "2026-01-07",
    returnFrom: "2026-01-08",
    returnTo: "2026-01-14",
  });
  assert.deepEqual(ok, {
    cohortVisitors: 0,
    consentfulVisitors: 0,
    returnedVisitors: 0,
    returnRate: 0,
  });
  await client.close();
});

test("get_device_breakdown returns the two rankings", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView({ deviceType: "mobile", browser: "Safari" }));
  });
  const result = await call(client, "get_device_breakdown", PERIOD);
  assert.deepEqual(result, {
    deviceTypes: {
      items: [{ deviceType: "mobile", sessions: 1 }],
      groups: 1,
      total: 1,
    },
    browsers: {
      items: [{ browser: "Safari", sessions: 1 }],
      groups: 1,
      total: 1,
    },
  });
  await client.close();
});

// Not asserted empty: run from a clone with no /data volume, the
// registry legitimately reports that the events directory could not be
// created — which is exactly the kind of thing this tool is for.
test("get_schema_errors reports the events directory and each load error's file and messages", async () => {
  const { client } = await connect();
  const result = (await call(client, "get_schema_errors")) as {
    source: string;
    errors: { file: string; messages: string[] }[];
  };
  assert.equal(typeof result.source, "string");
  for (const error of result.errors) {
    assert.equal(typeof error.file, "string");
    assert.ok(error.messages.length > 0, "an error says what was wrong");
  }
  await client.close();
});

// json_extract compares "5" and 5 as unequal, so a wrongly typed value
// used to come back as zero sessions — "no data" for "wrong argument".
test("a segment value whose type differs from the prop's declaration is refused", async () => {
  const { client } = await connect();
  const result = await call(client, "get_traffic_summary", {
    segment: [{ event: "page_view", property: "page_title", value: 5 }],
    ...PERIOD,
  });

  assert.match(String(result.error), /declared as string/);
  assert.match(String(result.error), /value given is a number/);
  await client.close();
});

test("get_steps_funnel names the unit it counted, per scope", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView());
  });
  const bySession = (await call(client, "get_steps_funnel", {
    steps: ["page_view", "file_download"],
    ...PERIOD,
  })) as { scope: string; steps: Record<string, unknown>[] };
  assert.equal(bySession.scope, "session");
  assert.deepEqual(bySession.steps[0], {
    event: "page_view",
    sessions: 1,
    conversionRate: 1,
  });

  const byVisitor = (await call(client, "get_steps_funnel", {
    steps: ["page_view", "file_download"],
    scope: "visitor",
    ...PERIOD,
  })) as { scope: string; steps: Record<string, unknown>[] };
  assert.equal(byVisitor.scope, "visitor");
  assert.equal(byVisitor.steps[0]!.visitors, 1);
  await client.close();
});

test("get_steps_funnel names every unknown step, not just the first", async () => {
  const { client } = await connect();
  const result = await call(client, "get_steps_funnel", {
    steps: ["page_view", "nope", "also_nope"],
    ...PERIOD,
  });

  assert.match(String(result.error), /nope, also_nope/);
  await client.close();
});

// --- shape and wiring ---

// A zero summary is ambiguous: quiet period, or tracking never installed?
test("get_traffic_summary flags a database that has never seen an event", async () => {
  const { client } = await connect();
  const empty = await call(client, "get_traffic_summary", PERIOD);
  assert.match(String(empty.note), /No events have ever been recorded/);

  const { client: seeded } = await connect((db) => insertEvent(db, pageView()));
  const withData = await call(seeded, "get_traffic_summary", PERIOD);
  assert.equal(withData.note, undefined, "a quiet period is not an error");

  await client.close();
  await seeded.close();
});

test("get_top_pages honours its limit and groups by path", async () => {
  const { client } = await connect((db) => {
    for (let i = 0; i < 4; i++) {
      insertEvent(
        db,
        pageView({
          sessionId: `s${i}`,
          ts: `2026-01-01T10:0${i}:00.000Z`,
          // Same path, different query strings — one page, not four.
          url: `https://example.com/pricing?utm_source=${i}`,
        }),
      );
    }
  });

  const pages = await call(client, "get_top_pages", {
    ...PERIOD,
    limit: 1,
  });

  assert.deepEqual(pages, {
    items: [{ path: "/pricing", views: 4 }],
    groups: 1,
    total: 4,
  });
  await client.close();
});

// The only tool that writes. MCP has no interactive confirmation, so the
// two-step shape is the confirmation.
test("delete_visitor_data previews before it deletes", async () => {
  const { db, client } = await connect((db) => {
    insertEvent(db, pageView());
    insertEvent(db, pageView({ ts: "2026-01-01T10:05:00.000Z" }));
  });

  const preview = await call(client, "delete_visitor_data", {
    visitor_id: "v1",
  });
  assert.equal(preview.wouldDelete, 2);
  assert.equal(eventCount(db), 2, "a preview must not delete anything");

  const deleted = await call(client, "delete_visitor_data", {
    visitor_id: "v1",
    confirm: true,
  });
  assert.equal(deleted.deleted, 2);
  assert.equal(eventCount(db), 0);
  await client.close();
});

// --- the resource the agent is told to read first ---

test("the schema-registry resource exposes every registered event", async () => {
  const { client } = await connect();
  const { contents } = await client.readResource({
    uri: "genug://schema-registry",
  });
  const registry = JSON.parse(resourceText(contents)) as Record<
    string,
    { props: Record<string, unknown> }
  >;

  assert.deepEqual(
    Object.keys(registry).sort(),
    Object.keys(eventRegistry).sort(),
  );
  assert.ok(registry.page_view!.props.page_title, "props reach the agent");
  await client.close();
});

// lib/context.test.ts covers what the document says in each state.
// This covers the wiring only: that it is registered, reachable at the
// URI the agent is given, and served as markdown rather than JSON.
test("the deployment-context resource is reachable and is markdown", async () => {
  const { client } = await connect();
  const { contents } = await client.readResource({
    uri: "genug://deployment-context",
  });

  assert.match(resourceText(contents), /^# Deployment context/);
  assert.equal(
    (contents[0] as { mimeType?: string }).mimeType,
    "text/markdown",
  );
  await client.close();
});

// The tool fallback for clients that don't surface MCP resources to
// the model — same content, reached a different way.
test("get_deployment_context returns the same markdown as the resource", async () => {
  const { client } = await connect();
  const { contents } = await client.readResource({
    uri: "genug://deployment-context",
  });
  const { text } = await callRaw(client, "get_deployment_context", {});

  assert.equal(text, resourceText(contents));
  await client.close();
});

// Role tags are internal wiring for the client script; an agent seeing
// them would only be distracted by a field it can't use.
test("role tags never reach the agent", async () => {
  const { client } = await connect();
  const { contents } = await client.readResource({
    uri: "genug://schema-registry",
  });

  assert.equal(resourceText(contents).includes("pageView"), false);
  await client.close();
});

// Unlike a role tag, conversion is meant to reach the agent — it marks
// a business goal, not client/server wiring, and no query resolves
// through it the way pageView does.
//
// Only proves the field is present and false for an unflagged event —
// none of the shipped built-ins set _conversion, so this can't prove a
// true value makes it through this handler's own mapping. That case is
// proven once, at registry.ts's serializeRegistry (see its test file):
// this handler's own mapping is the same one-line `definition.
// conversion` read, so a second fixture here would duplicate that
// proof rather than add to it.
test("list_event_types reports the conversion field for an unflagged event", async () => {
  const { client } = await connect();
  const types = (await call(client, "list_event_types")) as unknown as {
    name: string;
    description: string;
    conversion: boolean;
  }[];

  const pageView = types.find((t) => t.name === "page_view");
  assert.equal(pageView?.conversion, false);
  await client.close();
});

// Which tools hand the agent text a visitor wrote. Hand-maintained,
// because nothing here can see what a given tool's rows actually
// contain — but a named list at least makes dropping the warning from
// one of them fail here, rather than in an agent's answer months later.
const TOOLS_RETURNING_VISITOR_TEXT = [
  "get_events_by_property",
  "get_top_entry_params",
  "get_top_languages",
  "get_recent_events",
  "get_top_bounce_pages",
  "get_top_entry_pages",
  "get_top_exit_pages",
  "get_top_pages",
  "get_top_referrers",
  "get_top_rejected_events",
];

test("every tool returning visitor-written text warns the agent about it", async () => {
  const { client } = await connect();
  const described = new Map(
    (await listTools(client)).map((tool) => [
      tool.name,
      tool.description ?? "",
    ]),
  );

  const missing = TOOLS_RETURNING_VISITOR_TEXT.filter((name) => {
    assert.ok(described.has(name), `${name} is no longer registered`);
    return !described.get(name)!.includes(VISITOR_TEXT_CAVEAT);
  });

  assert.deepEqual(
    missing,
    [],
    "/events is public, so these return text a stranger can write — each has to tell the agent not to follow it",
  );
  await client.close();
});
