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

  // Compared against the registry itself rather than a hardcoded list:
  // the point of this test is that serializeRegistry mirrors whatever
  // is registered, so restating the names here would just mean every
  // new event breaks a test that isn't about it.
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
  // Only proves the field carries across, not that a *true* value
  // survives — none of the shipped built-ins set _conversion, so both
  // sides here are always false. See the dedicated test below.
  assert.equal(
    summary.page_view.conversion,
    eventRegistry.page_view.conversion,
  );
});

// The test above can't prove a true value survives, because nothing
// shipped sets one — it would pass unchanged if serializeRegistry
// hardcoded `conversion: false`. serializeRegistry takes a registry
// parameter for exactly this: hand it a synthetic one built the same
// way loadEvents.test.ts's fixtures are (a real temp directory), same
// as resolveTaggedEvent's tests do above.
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

// registry.ts throws when the shipped files do not load, which cannot
// be caught from inside a test that had to import the module to run.
// Asserting the files themselves are clean checks the same thing from
// the other side — same approach as the pageView-tag test below, which
// stands in for the throw it would otherwise have to provoke.
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

// What the server resolves a client-sent role to. Derived from the
// registry rather than restated, so a renamed event is recorded under
// its new name with nothing else touched — and, unlike the name list
// this replaced, without the client ever being told.
test("roleEventNames maps each role to what this deployment registers", () => {
  assert.deepEqual(roleEventNames, {
    pageView: pageViewEventType,
    outboundClick: "outbound_link_click",
    fileDownload: "file_download",
  });
});

// Deliberately not filled in with the built-in name. A deployment that
// registers no outbound-click event has none, and an automatic outbound
// click then rejects as an unknown event type naming the missing tag —
// one diagnostic, in the place every other mistracked event already
// surfaces.
test("a role nothing carries resolves to undefined, not a default name", () => {
  assert.equal(
    resolveTaggedEvent({ a: {}, b: {} }, "outboundClick"),
    undefined,
  );
  assert.equal(resolveTaggedEvent({ a: {}, b: {} }, "fileDownload"), undefined);
});

// The generalization that matters: the same resolver serves every role
// tag, so all three client-fired names follow a rename identically.
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

// A renamed built-in must still be found, which is the whole point of
// tagging these rather than hardcoding their names anywhere.
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

// The registry is what an AI agent reads to ground itself before
// answering a question, so a blank or throwaway description isn't a
// style problem — it's the agent being handed unlabeled data and
// guessing. These run over whatever the deployment actually registers,
// so a custom event added by someone tailoring their own instance is
// held to the same bar as the built-ins. Prose can't be checked
// automatically; emptiness and obvious placeholders can.
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

// Exactly one event must carry the pageView tag: resolveTaggedEvent
// throws on more than one, and registry.ts throws on none. The zero case
// used to be allowed, which put an "or this deployment has no page-view
// concept" branch into every traffic result, the cockpit and five tool
// descriptions, to serve a deployment that cannot meaningfully exist.
test("exactly one registered event carries the pageView tag", () => {
  const tagged = Object.entries(eventRegistry).filter(
    ([, definition]) => definition.pageView,
  );
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0]![0], pageViewEventType);
});

test("resolveTaggedEvent returns undefined when nothing carries the tag", () => {
  // The registry module turns this into a startup throw; the resolver
  // itself stays general, since the other two tags are allowed to be
  // absent and fall back to their built-in names.
  assert.equal(resolveTaggedEvent({ a: {}, b: {} }, "pageView"), undefined);
});
