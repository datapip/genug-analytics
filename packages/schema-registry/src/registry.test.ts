import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventRegistry,
  serializeRegistry,
  pageViewEventType,
  resolveTaggedEvent,
  roleEventNames,
} from "./registry.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvents, formatSchemaErrors } from "./loadEvents.js";

test("page_view accepts valid props and rejects missing ones", () => {
  const result = eventRegistry.page_view.schema.safeParse({
    page_title: "Pricing",
    document_language: "en",
  });
  assert.equal(result.success, true);

  const missing = eventRegistry.page_view.schema.safeParse({
    page_title: "Pricing",
  });
  assert.equal(missing.success, false);
});

test("page_view rejects unrecognized prop keys", () => {
  const result = eventRegistry.page_view.schema.safeParse({
    page_title: "Pricing",
    document_language: "en",
    extra_prop: "not in the registry",
  });
  assert.equal(result.success, false);
});

test("each event's metadata mirrors the schema shape", () => {
  assert.deepEqual(Object.keys(eventRegistry.page_view.props).sort(), [
    "document_language",
    "page_title",
  ]);
});

test("serializeRegistry mirrors the registry's metadata without its Zod schemas", () => {
  const summary = serializeRegistry();

  // Compared with the registry itself, not a fixed list of names, so
  // adding an event doesn't break this test.
  assert.deepEqual(
    Object.keys(summary).sort(),
    Object.keys(eventRegistry).sort(),
  );
  assert.equal(
    summary.page_view.description,
    eventRegistry.page_view.description,
  );
  assert.deepEqual(summary.page_view.props, eventRegistry.page_view.props);
  assert.equal("schema" in summary.page_view, false);
  // No built-in event sets _conversion, so this only checks that the
  // field is passed through; the next test checks `true`.
  assert.equal(
    summary.page_view.conversion,
    eventRegistry.page_view.conversion,
  );
});

// Checks that `conversion: true` is passed through, with a registry
// built from a temporary folder (as in loadEvents.test.ts).
test("serializeRegistry carries a true conversion flag through, not just false", () => {
  const dir = mkdtempSync(join(tmpdir(), "genug-events-"));
  writeFileSync(
    join(dir, "signup.json"),
    JSON.stringify({
      _description: "Fired when a visitor signs up",
      _conversion: true,
    }),
  );
  const { registry, errors } = loadEvents(dir);
  assert.deepEqual(errors, []);

  const summary = serializeRegistry(registry);
  assert.equal(summary.signup!.conversion, true);
});

// registry.ts throws when a built-in file doesn't load, which a test
// importing it can't catch. So this checks the files themselves.
test("every event file shipped in the image loads without errors", () => {
  const { registry, errors } = loadEvents(
    fileURLToPath(new URL("../events", import.meta.url)),
  );
  assert.deepEqual(
    errors,
    [],
    `built-in event files must be valid:
${formatSchemaErrors(errors)}`,
  );
  assert.deepEqual(
    Object.keys(registry).sort(),
    Object.keys(eventRegistry).sort(),
  );
});

test("pageViewEventType resolves to page_view in the real registry", () => {
  assert.equal(pageViewEventType, "page_view");
});

test("resolveTaggedEvent returns undefined when nothing is tagged", () => {
  const result = resolveTaggedEvent(
    { foo: { pageView: false }, bar: { pageView: false } },
    "pageView",
  );
  assert.equal(result, undefined);
});

test("resolveTaggedEvent returns the one tagged event", () => {
  const result = resolveTaggedEvent(
    { foo: { pageView: false }, bar: { pageView: true } },
    "pageView",
  );
  assert.equal(result, "bar");
});

test("resolveTaggedEvent throws when more than one event is tagged", () => {
  assert.throws(
    () =>
      resolveTaggedEvent(
        { foo: { pageView: true }, bar: { pageView: true } },
        "pageView",
      ),
    /Multiple events are tagged pageView: true \(foo, bar\)/,
  );
});

test("outbound_link_click accepts valid props", () => {
  const result = eventRegistry.outbound_link_click.schema.safeParse({
    target_url: "https://partner.example/pricing",
    target_host: "partner.example",
    link_text: "See our partner",
  });
  assert.equal(result.success, true);
});

test("file_download accepts valid props, including an empty extension", () => {
  const result = eventRegistry.file_download.schema.safeParse({
    file_url: "https://example.com/generate/report",
    file_extension: "",
    link_text: "Download the report",
  });
  assert.equal(result.success, true);
});

test("file_download rejects props with a missing field", () => {
  const result = eventRegistry.file_download.schema.safeParse({
    file_url: "https://example.com/a.pdf",
  });
  assert.equal(result.success, false);
});

// The event name the server uses for each role the client sends. Taken
// from the registry, so a renamed event is stored under its new name
// without any change to the client.
test("roleEventNames maps each role to what this deployment registers", () => {
  assert.deepEqual(roleEventNames, {
    pageView: pageViewEventType,
    outboundClick: "outbound_link_click",
    fileDownload: "file_download",
  });
});

// No built-in name as a fallback: without an outbound-click event, an
// automatic outbound click is rejected as unknown, naming the missing
// tag, like every other rejected event.
test("a role nothing carries resolves to undefined, not a default name", () => {
  assert.equal(
    resolveTaggedEvent({ a: {}, b: {} }, "outboundClick"),
    undefined,
  );
  assert.equal(resolveTaggedEvent({ a: {}, b: {} }, "fileDownload"), undefined);
});

// The same lookup works for every role tag, so all three follow a
// rename.
test("resolveTaggedEvent reads whichever tag it is asked for", () => {
  const registry = {
    a_page: { pageView: true },
    a_link: { outboundClick: true },
    a_file: { fileDownload: true },
  };

  assert.equal(resolveTaggedEvent(registry, "pageView"), "a_page");
  assert.equal(resolveTaggedEvent(registry, "outboundClick"), "a_link");
  assert.equal(resolveTaggedEvent(registry, "fileDownload"), "a_file");
});

test("resolveTaggedEvent names the offending tag when two events share it", () => {
  assert.throws(
    () =>
      resolveTaggedEvent(
        { one: { fileDownload: true }, two: { fileDownload: true } },
        "fileDownload",
      ),
    /Multiple events are tagged fileDownload: true \(one, two\)/,
  );
});

// A renamed built-in is still found, which is why roles are tags and
// not fixed names.
test("a renamed event is still found through its role tag", () => {
  const renamed = {
    seitenaufruf: { pageView: true },
    externer_klick: { outboundClick: true },
    datei_download: { fileDownload: true },
  };

  assert.equal(resolveTaggedEvent(renamed, "pageView"), "seitenaufruf");
  assert.equal(resolveTaggedEvent(renamed, "outboundClick"), "externer_klick");
  assert.equal(resolveTaggedEvent(renamed, "fileDownload"), "datei_download");
});

// The agent reads the registry to understand the data, so empty or
// placeholder descriptions leave it guessing. These checks run over all
// registered events, including a deployment's own. Whether the text is
// good can't be tested; whether it is missing can.
test("every registered event describes itself", () => {
  for (const [name, definition] of Object.entries(eventRegistry)) {
    assert.ok(
      definition.description.trim().length >= 10,
      `Event "${name}" needs a real description — it is what the AI agent reads to understand what this event means.`,
    );
  }
});

test("every registered prop describes itself", () => {
  for (const [name, definition] of Object.entries(eventRegistry)) {
    for (const [prop, meta] of Object.entries(definition.props)) {
      assert.ok(
        meta.description.trim().length >= 10,
        `Prop "${prop}" on event "${name}" needs a real description — an agent can't interpret a value it has no words for.`,
      );
      assert.ok(
        meta.example !== undefined,
        `Prop "${prop}" on event "${name}" needs an example value.`,
      );
    }
  }
});

// Exactly one event must have the pageView tag: resolveTaggedEvent
// throws on more than one, and registry.ts throws on none.
test("exactly one registered event carries the pageView tag", () => {
  const tagged = Object.entries(eventRegistry).filter(
    ([, definition]) => definition.pageView,
  );
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0]![0], pageViewEventType);
});

test("resolveTaggedEvent returns undefined when nothing carries the tag", () => {
  // registry.ts turns this into an error at startup. The lookup itself
  // allows a missing tag, since the other two roles may be missing.
  assert.equal(resolveTaggedEvent({ a: {}, b: {} }, "pageView"), undefined);
});
