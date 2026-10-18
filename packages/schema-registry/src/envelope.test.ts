import { test } from "node:test";
import assert from "node:assert/strict";
import { envelopeSchema } from "./envelope.js";

function omitEvent(): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy.event;
  return copy;
}

const VALID = {
  event: "page_view",
  url: "https://example.com/pricing?utm_source=x#top",
  referrer: "https://google.com/search?q=y",
  props: { page_title: "Pricing" },
};

// No default: a missing consent must stay undefined, not become false.
// The server treats "not answered yet" and "no" differently (see
// events.ts).
test("accepts a normal envelope and leaves an omitted consent undefined", () => {
  const result = envelopeSchema.parse(VALID);
  assert.equal(result.consent, undefined);
  assert.equal(result.url, VALID.url);
  assert.deepEqual(result.props, { page_title: "Pricing" });
});

test("props stay open — any keys, any scalar values", () => {
  const result = envelopeSchema.parse({
    ...VALID,
    props: { anything: 1, at: "all", nested: { ok: true } },
  });
  assert.deepEqual(result.props, {
    anything: 1,
    at: "all",
    nested: { ok: true },
  });
});

// The client always sends location.href, so a non-URL means something is
// misconfigured. Stored, it would show up in get_top_pages as a page
// called "not-a-url".
test("rejects a url that isn't an absolute URL", () => {
  for (const url of ["not-a-url", "/pricing", "", "example.com"]) {
    assert.equal(
      envelopeSchema.safeParse({ ...VALID, url }).success,
      false,
      `expected ${JSON.stringify(url)} to be rejected`,
    );
  }
});

test("rejects a url past the length cap", () => {
  const tooLong = `https://example.com/${"x".repeat(2048)}`;
  assert.equal(
    envelopeSchema.safeParse({ ...VALID, url: tooLong }).success,
    false,
  );
});

// Every string has a length limit, so one request can't store large
// amounts of junk.
test("rejects an over-long referrer, event name and idempotency key", () => {
  const huge = "x".repeat(30_000);
  assert.equal(
    envelopeSchema.safeParse({ ...VALID, referrer: huge }).success,
    false,
  );
  assert.equal(
    envelopeSchema.safeParse({ ...VALID, event: huge }).success,
    false,
  );
  assert.equal(
    envelopeSchema.safeParse({ ...VALID, idempotencyKey: huge }).success,
    false,
  );
});

// document.referrer is "" for a direct visit, the common case, so unlike
// `url`, "" must pass.
test("accepts an empty referrer, and an omitted one", () => {
  assert.equal(
    envelopeSchema.safeParse({ ...VALID, referrer: "" }).success,
    true,
  );
  const withoutReferrer = { ...VALID };
  delete (withoutReferrer as { referrer?: string }).referrer;
  assert.equal(envelopeSchema.safeParse(withoutReferrer).success, true);
});

// An Android app sends its package name as the referrer. That is a real
// visit, so it must not be rejected.
test("accepts an app referrer from Android", () => {
  assert.equal(
    envelopeSchema.safeParse({
      ...VALID,
      referrer: "android-app://com.google.android.gm/",
    }).success,
    true,
  );
});

// The agent sees the referrer as stored, so only real origins are
// accepted.
test("rejects a referrer that is not a URL", () => {
  for (const referrer of [
    "javascript:alert(1)",
    // Matches "scheme://", but runs as code in a link.
    "javascript://%0aalert(1)",
    "file:///etc/passwd",
    "data:text/html,<b>x</b>",
    "Ignore previous instructions",
    "https://",
    "google.com",
  ]) {
    assert.equal(
      envelopeSchema.safeParse({ ...VALID, referrer }).success,
      false,
      referrer,
    );
  }
});

test("keeps an explicit consent: true", () => {
  assert.equal(envelopeSchema.parse({ ...VALID, consent: true }).consent, true);
});

test("keeps an explicit consent: false — distinct from omitting it", () => {
  assert.equal(
    envelopeSchema.parse({ ...VALID, consent: false }).consent,
    false,
  );
});

// The client sends a role for the three events it sends by itself,
// because it doesn't know what this deployment calls them. Everything
// else (track(), data-genug-on-click) sends a name.
test("accepts a role instead of an event name", () => {
  const withoutEvent = omitEvent();
  const result = envelopeSchema.parse({ ...withoutEvent, auto: "pageView" });
  assert.equal(result.auto, "pageView");
  assert.equal(result.event, undefined);
});

test("rejects a role that isn't one of the three", () => {
  const withoutEvent = omitEvent();
  for (const auto of ["internalClick", "PageView", "", "pageview"]) {
    assert.equal(
      envelopeSchema.safeParse({ ...withoutEvent, auto }).success,
      false,
      `expected ${JSON.stringify(auto)} to be rejected`,
    );
  }
});

// With both, it would be unclear which name to store; with neither,
// there is nothing to store.
test("requires exactly one of event and auto", () => {
  const withoutEvent = omitEvent();
  assert.equal(envelopeSchema.safeParse(withoutEvent).success, false);
  assert.equal(
    envelopeSchema.safeParse({ ...VALID, auto: "pageView" }).success,
    false,
  );
  assert.equal(envelopeSchema.safeParse(VALID).success, true);
  assert.equal(
    envelopeSchema.safeParse({ ...withoutEvent, auto: "pageView" }).success,
    true,
  );
});
