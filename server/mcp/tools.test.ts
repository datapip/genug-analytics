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

// These tests call the tools through the real MCP protocol, using the
// SDK's in-memory transport (no HTTP, nothing mocked). Calling the
// handlers directly would skip what happens around them: input
// validation, the period conversion, and the registerTool wrapper (tool
// list and period check).
//
// The numbers are tested in lib/; these test the tool layer: validation,
// read-only mode and the shape of the results.
async function connect(
  seed?: (db: Database.Database) => void,
  timezone = "UTC",
) {
  const db = new Database(":memory:");
  migrate(db);
  seed?.(db);

  const server = createMcpServer(db, { timezone });
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

// Plain dates, not full timestamps, because that is what an agent
// usually sends, and periodInput must convert them.
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

// Arguments some tools need besides the period, so the generated tests
// below reach the handler instead of failing validation. The next test
// checks this list is complete.
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

// A tool's description is all the agent knows about it: it decides which
// tool to call and how to read the result from this text. So it must be
// a real sentence, not a label like "orders". A test can only check the
// length; whether the text is correct needs a human review.
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

// The cockpit's tool list comes from this manifest, so it must match the
// tools that are really registered.
test("the manifest matches what is actually registered", async () => {
  const { db, client } = await connect();
  const listed = (await listTools(client)).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
  }));

  assert.deepEqual(
    [...getToolManifest(db, { timezone: "UTC" })].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    [...listed].sort((a, b) => a.name.localeCompare(b.name)),
  );
  await client.close();
});

// A client that asks before risky calls decides from these hints, and
// visitor text may try to talk an agent into deleting data. So every
// reading tool is marked read-only, and the two writing tools say they
// write (the delete as destructive).
test("every tool says whether it writes, and the delete says it destroys", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const writers = new Set(["delete_visitor_data", "add_history_note"]);

  for (const tool of tools) {
    const writes = writers.has(tool.name);
    assert.equal(
      tool.annotations?.readOnlyHint,
      !writes,
      `${tool.name} must say readOnlyHint: ${!writes}`,
    );
    assert.equal(tool.annotations?.openWorldHint, false, tool.name);
  }
  const erase = tools.find((tool) => tool.name === "delete_visitor_data");
  assert.equal(erase?.annotations?.destructiveHint, true);
  const note = tools.find((tool) => tool.name === "add_history_note");
  assert.equal(note?.annotations?.destructiveHint, false);
  await client.close();
});

// In read-only mode nothing can write. Checked through the protocol,
// because the writing tools must not be registered at all: a tool that
// isn't in tools/list can't be called.
test("a read-only server registers no writing tool, and its manifest says so", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const server = createMcpServer(db, { readOnly: true, timezone: "UTC" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-test", version: "1" });
  await client.connect(clientTransport);

  const names = (await listTools(client)).map((tool) => tool.name);
  assert.ok(!names.includes("delete_visitor_data"));
  // Writes text that every later session is told to follow, so it must
  // not be available with a public key either.
  assert.ok(!names.includes("add_history_note"));
  // Writes nothing, but returns raw rows, which a public key shouldn't
  // allow exporting.
  assert.ok(!names.includes("get_recent_events"));
  assert.ok(names.includes("get_traffic_summary"), "reads are still there");
  // The other diagnostic tools stay: a read-only demo still needs to
  // show that tracking works.
  assert.ok(names.includes("get_schema_errors"));
  assert.ok(names.includes("get_bot_activity"));

  const manifest = getToolManifest(db, { readOnly: true, timezone: "UTC" }).map(
    (t) => t.name,
  );
  assert.deepEqual([...manifest].sort(), [...names].sort());
  // And normal mode has its own tool list, not the same cached one.
  const writableNames = getToolManifest(db, { timezone: "UTC" }).map(
    (t) => t.name,
  );
  assert.ok(writableNames.includes("delete_visitor_data"));
  assert.ok(writableNames.includes("get_recent_events"));
  await client.close();
});

// Without this, a new tool with a new required argument would make the
// generated tests below pass for the wrong reason: by failing validation
// before reaching what they check.
test("test fixtures cover every tool's required arguments", async () => {
  const { client } = await connect();
  const uncovered: string[] = [];

  // Only the tools the generated tests call. A tool without a period
  // (delete_visitor_data) has its own test.
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

// The generated tests below really call every tool that has `from` and
// `to`. That is only safe for tools that read. A writing tool with the
// same arguments would actually write, on the machine running the tests.
// So this checks that none of them is a writing tool, using the read-only
// split rather than a list of names.
test("no writing tool declares a query period", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const readOnlyNames = new Set(
    getToolManifest(db, { readOnly: true, timezone: "UTC" }).map(
      (tool) => tool.name,
    ),
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

// Generated from the tool list, so a new tool with a period is tested
// automatically.
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

test("get_recent_events adds a note when rows were dropped to fit the budget", async () => {
  // insertEvent doesn't apply the prop length limits, so a row this big
  // can be stored here to test the size limit.
  const { client } = await connect((db) => {
    for (let i = 0; i < 5; i++) {
      insertEvent(
        db,
        pageView({
          ts: `2026-01-01T10:0${i}:00.000Z`,
          props: { page_title: "x".repeat(20_000) },
        }),
      );
    }
  });
  const result = (await client.callTool({
    name: "get_recent_events",
    arguments: { limit: 5 },
  })) as { content: { type: string; text: string }[] };

  const rows = JSON.parse(result.content[0]!.text) as unknown[];
  assert.equal(rows.length, 3);
  assert.match(result.content[1]!.text, /newest 3 of the 5 requested/);
  await client.close();
});

// SQLite compares ts as text, so a plain "2026-01-01" as `to` sorts
// before every timestamp of that day and would drop the whole day. The
// agent would report the wrong number with confidence, so this is the
// most important test in this file.
test("a bare `to` date covers the whole day, not midnight", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView({ ts: "2026-01-01T23:59:59.500Z" }));
  });

  const summary = await call(client, "get_traffic_summary", PERIOD);
  assert.equal(summary.viewEvents, 1, "the last event of the day was dropped");
  await client.close();
});

// Returned as a normal tool error the agent can read and retry, not as
// a protocol exception or a wrong number.
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

// Each refusal says what to do instead.
test("get_traffic_change refuses what it cannot judge", async () => {
  const { client } = await connect();
  const long = await call(client, "get_traffic_change", {
    from: "2026-01-01",
    to: "2026-03-01",
  });
  assert.match(String(long.error), /31/);
  assert.match(String(long.error), /get_traffic_by_day/, "offers a way out");

  // A 31-day month with the autumn clock change is 31 local days,
  // although its length in milliseconds rounds up to 32 days.
  const { client: berlin } = await connect(undefined, "Europe/Berlin");
  const october = await call(berlin, "get_traffic_change", {
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.equal(october.error, undefined);
  await berlin.close();

  const future = await call(client, "get_traffic_change", {
    from: "9999-01-01",
    to: "9999-01-02",
  });
  assert.match(String(future.error), /future/);

  const unknown = await call(client, "get_traffic_change", {
    ...PERIOD,
    event: "no_such_event",
  });
  assert.match(String(unknown.error), /Unknown event type/);
  assert.match(String(unknown.error), /page_view/, "lists the valid ones");
  await client.close();
});

// The other tests use UTC, where a plain date is the same day either
// way, so a tool ignoring the time zone would pass them. 22:30 UTC on
// the 29th is 00:30 on the 30th in Berlin.
test("a bare date means the site's day, through the tool layer", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, {
      event: "page_view",
      visitorId: "v",
      sessionId: "s",
      ts: "2026-09-29T22:30:00.000Z",
      url: "https://example.com/",
      props: {},
    });
  }, "Europe/Berlin");

  const result = (await call(client, "get_traffic_by_day", {
    from: "2026-09-30",
    to: "2026-09-30",
  })) as unknown as { date: string; viewEvents: number }[];
  assert.deepEqual(
    result.map((row) => [row.date, row.viewEvents]),
    [["2026-09-30", 1]],
  );

  const { tools } = await client.listTools();
  const byDay = tools.find((tool) => tool.name === "get_traffic_by_day");
  assert.match(byDay?.description ?? "", /Europe\/Berlin/);
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

// SUM over a text prop would return 0, which reads as "no revenue"
// instead of "wrong prop".
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

// MCP's flag for a failed call. Without it a client shows the error as
// a normal result.
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

// Values that pass the schema but can never match anything.
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

// With the lookup off no row has a country, so any country would match
// nothing and look like "nobody from there".
test("countries refuse to answer when no lookup ran, and a country segment too", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView());
  });
  const countries = await callRaw(client, "get_top_countries", PERIOD);
  assert.equal(countries.isError, true);
  assert.match(countries.text, /COUNTRY_LOOKUP=true/);

  const segmented = await call(client, "get_traffic_summary", {
    segment: [{ country: "DE" }],
    ...PERIOD,
  });
  assert.match(String(segmented.error), /COUNTRY_LOOKUP=true/);
  await client.close();
});

test("a country segment takes a two-letter code in either case", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView({ sessionId: "s1", country: "DE" }));
    insertEvent(db, pageView({ sessionId: "s2", country: "US" }));
  });
  const refused = await call(client, "get_traffic_summary", {
    segment: [{ country: "Germany" }],
    ...PERIOD,
  });
  assert.match(String(refused.error), /two-letter code/);

  const lower = await call(client, "get_top_countries", {
    segment: [{ country: "de" }],
    ...PERIOD,
  });
  assert.deepEqual(lower, {
    items: [{ country: "DE", sessions: 1 }],
    groups: 1,
    total: 1,
    notLookedUp: 0,
  });
  await client.close();
});

// On the day the lookup is turned on, a period has sessions with and
// without a country. Only a period with no country at all is an error.
test("countries answer for a period that is only partly looked up", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView({ sessionId: "s1" }));
    insertEvent(db, pageView({ sessionId: "s2", country: "DE" }));
    insertEvent(db, pageView({ sessionId: "s3", country: "DE" }));
  });
  assert.deepEqual(await call(client, "get_top_countries", PERIOD), {
    items: [{ country: "DE", sessions: 2 }],
    groups: 1,
    total: 2,
    notLookedUp: 1,
  });
  await client.close();
});

// A mistyped host, or a site of another installation, would otherwise
// look like a site nobody visited.
test("a host segment names the hosts in the period when its own has no session", async () => {
  const { client } = await connect((db) => {
    insertEvent(db, pageView({ sessionId: "s1", url: "https://example.com/" }));
    insertEvent(
      db,
      pageView({ sessionId: "s2", url: "https://shop.example.com/" }),
    );
    insertEvent(
      db,
      pageView({ sessionId: "s3", url: "https://shop.example.com/cart" }),
    );
  });
  const typo = await call(client, "get_traffic_summary", {
    segment: [{ host: "shop.exmaple.com" }],
    ...PERIOD,
  });
  assert.match(
    String(typo.error),
    /"shop\.exmaple\.com".*busiest first: shop\.example\.com, example\.com\./,
  );
  assert.ok(String(typo.error).includes(VISITOR_TEXT_CAVEAT));

  const url = await call(client, "get_traffic_summary", {
    segment: [{ host: "https://example.com/" }],
    ...PERIOD,
  });
  assert.match(String(url.error), /not a URL/);

  const pages = await call(client, "get_top_pages", {
    segment: [{ host: "WWW.Shop.Example.com" }],
    ...PERIOD,
  });
  assert.deepEqual(pages, {
    items: [
      { host: "shop.example.com", path: "/", views: 1 },
      { host: "shop.example.com", path: "/cart", views: 1 },
    ],
    groups: 2,
    total: 2,
  });
  await client.close();
});

// A browser sends a domain with an umlaut as punycode, and it is stored
// that way; the owner types it with the umlaut.
test("a host segment matches an umlaut domain as typed", async () => {
  const { client } = await connect((db) => {
    insertEvent(
      db,
      pageView({ sessionId: "s1", url: "https://bücher.example/" }),
    );
    insertEvent(db, pageView({ sessionId: "s2", url: "https://example.com/" }));
  });
  const pages = await call(client, "get_top_pages", {
    segment: [{ host: "bücher.example" }],
    ...PERIOD,
  });
  assert.deepEqual(pages, {
    items: [{ host: "xn--bcher-kva.example", path: "/", views: 1 }],
    groups: 1,
    total: 1,
  });
  await client.close();
});

// Stored rows may have many hosts, so the error lists only a few.
test("a host segment's error lists only the busiest hosts", async () => {
  const { client } = await connect((db) => {
    for (let i = 0; i < 12; i++) {
      insertEvent(
        db,
        pageView({ sessionId: `s${i}`, url: `https://h${i}.example/` }),
      );
    }
  });
  const result = await call(client, "get_traffic_summary", {
    segment: [{ host: "example.com" }],
    ...PERIOD,
  });
  assert.match(String(result.error), / and 2 more\./);
  await client.close();
});

// Zero is correct for every site in an empty period, so it isn't
// refused.
test("a host segment over a period with no sessions answers with zeros", async () => {
  const { client } = await connect();
  const summary = await call(client, "get_traffic_summary", {
    segment: [{ host: "example.com" }],
    ...PERIOD,
  });
  assert.equal(summary.error, undefined);
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
    items: [{ host: "example.com", path: "/m", views: 1 }],
    groups: 1,
    total: 1,
  });
  await client.close();
});

// Catches a tool that takes `segment` but never passes the condition on
// to its query: the queries default to NO_SEGMENT, so that compiles and
// returns whole-site numbers. The data has one quiet mobile session and
// two busier desktop ones that differ in every way, so every tool's
// answer changes when limited to mobile.
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
        country: "DE",
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
          country: "US",
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

  // No built-in event has a number prop to sum; its segment is tested in
  // lib/events.test.ts instead.
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

// Checks the exception list in mcp/tools.ts both ways: no tool may be on
// it without reason, and no entry may name a tool that no longer exists.
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

// Not checked to be empty: in a git clone without /data, the registry
// reports that the events folder couldn't be created, which is exactly
// what this tool is for.
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

// json_extract treats "5" and 5 as different, so a value of the wrong
// type would give zero sessions, "no data" instead of "wrong argument".
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

// All zeros can mean a quiet period or tracking that was never set up.
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
          // Same path, different query strings: one page, not four.
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
    items: [{ host: "example.com", path: "/pricing", views: 4 }],
    groups: 1,
    total: 4,
  });
  await client.close();
});

// Deletes data. MCP has no "are you sure?" prompt, so the tool needs a
// second call to confirm.
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

// lib/context.test.ts tests the document's content. This only checks
// that it is registered at the URI the agent is given and served as
// markdown.
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

// MCP's `instructions`, sent when the client connects, before the agent
// calls anything. Only checks that it names the resource and the tool,
// not the exact wording, so the text can change without editing this
// test.
test("server instructions point the agent at deployment context", async () => {
  const { client } = await connect();

  const instructions = client.getInstructions();

  assert.match(instructions ?? "", /deployment-context/);
  assert.match(instructions ?? "", /get_deployment_context/);
  await client.close();
});

// An agent connected to several installations tells them apart by the
// name and instructions, which also say that numbers cover all sites.
test("the server's name and instructions name the sites it collects for", async () => {
  async function initialize(siteHosts: string[]) {
    const db = new Database(":memory:");
    migrate(db);
    const server = createMcpServer(db, { timezone: "UTC", siteHosts });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "tools-test", version: "1" });
    await client.connect(clientTransport);
    const seen = {
      name: client.getServerVersion()?.name,
      instructions: client.getInstructions() ?? "",
    };
    await client.close();
    return seen;
  }

  const one = await initialize(["brotrechner.de"]);
  assert.equal(one.name, "genug (brotrechner.de)");
  assert.match(one.instructions, /collects for brotrechner\.de\./);
  assert.doesNotMatch(one.instructions, /host segment/);

  const two = await initialize(["brotrechner.de", "datapip.de"]);
  assert.equal(two.name, "genug (brotrechner.de, datapip.de)");
  assert.match(two.instructions, /brotrechner\.de, datapip\.de/);
  assert.match(two.instructions, /host segment/);
  assert.match(two.instructions, /deployment-context/);
});

// The tool for clients that don't show MCP resources to the agent: the
// same content as the resource.
test("get_deployment_context returns the same markdown as the resource", async () => {
  const { client } = await connect();
  const { contents } = await client.readResource({
    uri: "genug://deployment-context",
  });
  const { text } = await callRaw(client, "get_deployment_context", {});

  assert.equal(text, resourceText(contents));
  await client.close();
});

// Role tags are internal (for the client script); the agent can't use
// them, so they are left out.
test("role tags never reach the agent", async () => {
  const { client } = await connect();
  const { contents } = await client.readResource({
    uri: "genug://schema-registry",
  });

  assert.equal(resourceText(contents).includes("pageView"), false);
  await client.close();
});

// Unlike role tags, conversion is shown to the agent: it marks a
// business goal.
//
// No built-in event sets _conversion, so this only checks that the field
// is there and false. That `true` is passed through is tested for
// serializeRegistry in registry.test.ts.
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

// The tools that return text written by visitors. Kept by hand, since a
// test can't see what a tool returns, but with the list, removing the
// warning from one of them fails here.
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
