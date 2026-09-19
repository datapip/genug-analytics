import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvents, formatSchemaErrors } from "./loadEvents.js";
import { resolveTaggedEvent } from "./registry.js";

const PAGE_VIEW = {
  _description: "Fired when a visitor views a page",
  _pageView: true,
  page_title: "string",
  page_title_description: "The document's title",
  page_title_example: "Pricing — Genug",
};

// Real files in a real directory rather than a mocked filesystem: the
// thing under test is largely "what happens to the contents of a
// directory", and tsc does not copy .json into dist, so fixtures have
// to be written at run time anyway.
function directoryWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-events-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return dir;
}

test("loads a directory into a registry keyed by filename", () => {
  const { registry, errors } = loadEvents(
    directoryWith({ "page_view.json": PAGE_VIEW }),
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(registry), ["page_view"]);
  const event = registry.page_view!;
  assert.equal(event.description, "Fired when a visitor views a page");
  assert.equal(event.pageView, true);
  assert.equal(event.fileDownload, false);
  assert.deepEqual(event.props.page_title, {
    description: "The document's title",
    example: "Pricing — Genug",
    type: "string",
    required: true,
    list: false,
  });
});

test("builds a schema that validates props the way the rules say", () => {
  const { registry } = loadEvents(
    directoryWith({
      "order_placed.json": {
        _description: "Fired when an order is completed",
        order_total: "number",
        order_total_description: "Order value in the store's currency",
        order_total_example: 49.99,
        coupon_code: "string.optional",
        coupon_code_description: "Coupon applied to the order, if any",
        coupon_code_example: "SPRING10",
        was_gift: "boolean",
        was_gift_description: "Whether the buyer marked it as a gift",
        was_gift_example: false,
      },
    }),
  );

  const schema = registry.order_placed!.schema;
  assert.equal(
    schema.safeParse({ order_total: 49.99, was_gift: false }).success,
    true,
    "an optional prop may be omitted",
  );
  assert.equal(
    schema.safeParse({
      order_total: 49.99,
      was_gift: false,
      coupon_code: "SPRING10",
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ order_total: "49.99", was_gift: false }).success,
    false,
    "a number prop rejects a string",
  );
  assert.equal(
    schema.safeParse({ was_gift: false }).success,
    false,
    "a required prop may not be omitted",
  );
  // Strict, not stripping: every prop an event sends must have a
  // registry entry, so a typo shows up as a rejection rather than
  // vanishing.
  assert.equal(
    schema.safeParse({ order_total: 1, was_gift: false, extra: "x" }).success,
    false,
  );
});

test("the string cap from the rule string is the one the schema enforces", () => {
  const { registry } = loadEvents(
    directoryWith({
      "page_view.json": PAGE_VIEW,
      "outbound_link_click.json": {
        _description: "Fired when a visitor clicks a link to another site",
        target_url: "string.long",
        target_url_description: "Full URL the link points to",
        target_url_example: "https://partner.example.com/pricing",
      },
    }),
  );

  assert.equal(
    registry.page_view!.schema.safeParse({ page_title: "x".repeat(513) })
      .success,
    false,
  );
  assert.equal(
    registry.outbound_link_click!.schema.safeParse({
      target_url: `https://example.com/${"x".repeat(2000)}`,
    }).success,
    true,
  );
  assert.equal(
    registry.outbound_link_click!.schema.safeParse({
      target_url: "x".repeat(2049),
    }).success,
    false,
  );
});

test("a list prop's schema accepts an array and rejects a bare value", () => {
  const { registry } = loadEvents(
    directoryWith({
      "article_read.json": {
        _description: "Fired when a visitor finishes an article",
        tags: "string.list",
        tags_description: "Topics this article is filed under",
        tags_example: ["pricing", "analytics"],
        scores: "number.list.optional",
        scores_description: "Per-section engagement scores",
        scores_example: [0.5, 0.75],
      },
    }),
  );

  const schema = registry.article_read!.schema;
  assert.equal(schema.safeParse({ tags: ["pricing"] }).success, true);
  assert.equal(
    schema.safeParse({ tags: [] }).success,
    true,
    "an article with no tags is not an error",
  );
  assert.equal(
    schema.safeParse({ tags: "pricing" }).success,
    false,
    "a list prop does not quietly accept a single value",
  );
  assert.equal(schema.safeParse({ tags: ["a", 1] }).success, false);
  assert.equal(
    schema.safeParse({ tags: ["x".repeat(513)] }).success,
    false,
    "the cap applies per value",
  );
  assert.equal(
    schema.safeParse({ tags: Array(51).fill("x") }).success,
    false,
    "and there is a cap on how many values",
  );
  assert.equal(
    schema.safeParse({ tags: ["a"], scores: [0.5, 0.75] }).success,
    true,
  );
});

// A README or a stray .bak in the events directory is not an event.
test("ignores files that aren't .json", () => {
  const { registry, errors } = loadEvents(
    directoryWith({
      "page_view.json": PAGE_VIEW,
      "README.md": "# events",
      "page_view.json.bak": "{ broken",
    }),
  );

  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(registry), ["page_view"]);
});

// Filesystem order is not something to inherit: this decides the order
// events appear in the MCP resource and the cockpit.
test("registers events in filename order, whatever the directory says", () => {
  const { registry } = loadEvents(
    directoryWith({
      "zeta.json": { ...PAGE_VIEW, _pageView: false },
      "alpha.json": { ...PAGE_VIEW, _pageView: false },
    }),
  );
  assert.deepEqual(Object.keys(registry), ["alpha", "zeta"]);
});

// The point of collecting errors instead of throwing: one bad file must
// not take the rest of the deployment's events with it.
test("a broken file is reported by name and the others still load", () => {
  const { registry, errors } = loadEvents(
    directoryWith({
      "page_view.json": PAGE_VIEW,
      "broken.json": "{ not json",
      "wrong.json": { page_title: "strng" },
    }),
  );

  assert.deepEqual(Object.keys(registry), ["page_view"]);
  assert.deepEqual(
    errors.map((error) => error.file),
    ["broken.json", "wrong.json"],
  );
  assert.match(errors[0]!.messages.join(), /is not valid JSON/);
  assert.match(errors[1]!.messages.join(), /"_description" is missing/);
  assert.match(errors[1]!.messages.join(), /unknown type "strng"/);
});

test("rejects a filename that isn't a usable event name", () => {
  const { registry, errors } = loadEvents(
    directoryWith({ "page view.json": PAGE_VIEW }),
  );
  assert.deepEqual(registry, {});
  assert.match(
    errors[0]!.messages.join(),
    /"page view" is not a usable event name/,
  );
});

// The volume directory in phase 2 may legitimately not exist. Reported,
// never thrown — the caller decides whether that is fatal.
test("a missing directory is an error, not a crash", () => {
  const { registry, errors } = loadEvents(
    join(tmpdir(), "genug-events-does-not-exist"),
  );
  assert.deepEqual(registry, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.messages.join(), /could not be read/);
});

test("formatSchemaErrors names the file on every line", () => {
  const formatted = formatSchemaErrors([
    { file: "a.json", messages: ["first", "second"] },
    { file: "b.json", messages: ["third"] },
  ]);
  assert.deepEqual(formatted.split("\n"), [
    "  a.json: first",
    "  a.json: second",
    "  b.json: third",
  ]);
});

// --- role tags across a directory -----------------------------------

const CUSTOM = {
  _description: "Fired on the order confirmation page after checkout",
  order_total: "number",
  order_total_description: "Order total including tax",
  order_total_example: 49.9,
};

function load(files: Record<string, unknown>) {
  return loadEvents(directoryWith(files));
}

test("each role tag may be carried by a different event", () => {
  const { registry, errors } = load({
    "seitenaufruf.json": PAGE_VIEW,
    "externer_klick.json": { ...CUSTOM, _automaticOutboundClick: true },
    "datei_download.json": { ...CUSTOM, _automaticFileDownload: true },
  });

  assert.deepEqual(errors, []);
  assert.equal(resolveTaggedEvent(registry, "pageView"), "seitenaufruf");
  assert.equal(resolveTaggedEvent(registry, "outboundClick"), "externer_klick");
  assert.equal(resolveTaggedEvent(registry, "fileDownload"), "datei_download");
});

// Not merely wrong — resolveTaggedEvent throws on a tie, and the
// registry is built at import, so without this the second file stops
// the server from starting rather than being skipped like any other
// bad one. Copying page_view.json to seitenaufruf.json instead of
// renaming it is the way to arrive here.
test("two files claiming one tag: the first wins, the second is reported", () => {
  const { registry, errors } = load({
    "page_view.json": PAGE_VIEW,
    "seitenaufruf.json": PAGE_VIEW,
  });

  assert.deepEqual(Object.keys(registry), ["page_view"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.file, "seitenaufruf.json");
  assert.match(errors[0]!.messages.join(), /"page_view" already carries/);
  assert.equal(
    resolveTaggedEvent(registry, "pageView"),
    "page_view",
    "the registry must still resolve, not throw",
  );
});

// The rejection has to quote the key someone actually typed. The role
// is called fileDownload internally but is written
// "_automaticFileDownload", and a message naming the wrong one sends
// the reader looking for a key that does not exist.
test("the rejection names the JSON key, not the internal role name", () => {
  const { errors } = load({
    "a_download.json": { ...CUSTOM, _automaticFileDownload: true },
    "b_download.json": { ...CUSTOM, _automaticFileDownload: true },
  });

  assert.equal(errors.length, 1);
  assert.match(errors[0]!.messages.join(), /"_automaticFileDownload": true/);
});

// Files are read in sorted order, so which one loses is fixed rather
// than whatever the filesystem happened to hand back.
test("the losing file is decided by name, not by directory order", () => {
  const first = load({ "aaa.json": PAGE_VIEW, "zzz.json": PAGE_VIEW });
  const second = load({ "zzz.json": PAGE_VIEW, "aaa.json": PAGE_VIEW });

  assert.deepEqual(Object.keys(first.registry), ["aaa"]);
  assert.deepEqual(Object.keys(second.registry), ["aaa"]);
});

// A skipped file costs that event and nothing else — including the
// tag it wanted, which stays with whoever already had it.
test("a file rejected for a tag clash registers nothing at all", () => {
  const { registry, errors } = load({
    "order_placed.json": CUSTOM,
    "page_view.json": PAGE_VIEW,
    "seitenaufruf.json": PAGE_VIEW,
  });

  assert.deepEqual(Object.keys(registry).sort(), ["order_placed", "page_view"]);
  assert.equal(errors.length, 1);
});

// Unlike a role tag, _conversion carries no uniqueness rule: several
// events marking several business goals is the ordinary case, not a
// clash to report.
test("any number of events may carry _conversion, with no clash reported", () => {
  const { registry, errors } = load({
    "signup.json": { ...CUSTOM, _conversion: true },
    "order_placed.json": { ...CUSTOM, _conversion: true },
    "page_view.json": PAGE_VIEW,
  });

  assert.deepEqual(errors, []);
  assert.equal(registry.signup!.conversion, true);
  assert.equal(registry.order_placed!.conversion, true);
  assert.equal(registry.page_view!.conversion, false);
});
