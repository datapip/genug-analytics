import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUrl, stripUnknownParams } from "./url.js";

test("parseUrl splits a full URL into path, params, hash, and host", () => {
  assert.deepEqual(
    parseUrl("https://example.com/blog/post-1?utm_source=x&ref=y#section-2"),
    {
      path: "/blog/post-1",
      params: "utm_source=x&ref=y",
      hash: "section-2",
      host: "example.com",
    },
  );
});

test("parseUrl returns empty params/hash when absent", () => {
  assert.deepEqual(parseUrl("https://example.com/pricing"), {
    path: "/pricing",
    params: "",
    hash: "",
    host: "example.com",
  });
});

test("parseUrl returns the root path for the bare domain", () => {
  assert.deepEqual(parseUrl("https://example.com/"), {
    path: "/",
    params: "",
    hash: "",
    host: "example.com",
  });
});

test("parseUrl falls back to the raw string on an unparseable URL", () => {
  assert.deepEqual(parseUrl("not-a-url"), {
    path: "not-a-url",
    params: "",
    hash: "",
    host: "",
  });
});

test("stripUnknownParams keeps campaign and click-id parameters", () => {
  assert.equal(
    stripUnknownParams(
      "https://example.com/p?utm_source=news&utm_medium=email&gclid=abc&ref=partner",
    ),
    "https://example.com/p?utm_source=news&utm_medium=email&gclid=abc&ref=partner",
  );
});

// The reason this function exists: a newsletter link's address, a magic
// link's token and a search page's typed query are all read back
// verbatim by get_recent_events, and reach the agent's model vendor.
test("stripUnknownParams drops everything else", () => {
  assert.equal(
    stripUnknownParams("https://example.com/reset?token=secret123"),
    "https://example.com/reset",
  );
  assert.equal(
    stripUnknownParams("https://example.com/?email=a%40b.com&utm_source=news"),
    "https://example.com/?utm_source=news",
  );
  assert.equal(
    stripUnknownParams("https://example.com/search?q=how+do+i+cancel"),
    "https://example.com/search",
  );
});

test("stripUnknownParams leaves a URL with no query string alone", () => {
  assert.equal(
    stripUnknownParams("https://example.com/pricing"),
    "https://example.com/pricing",
  );
});

// The fragment used to be kept. It is the other half of the channel the
// allowlist above exists to close: an OAuth implicit response puts
// access_token there precisely to keep it out of server logs, and it
// would have been stored verbatim, read back to an agent and rendered
// in the cockpit.
test("stripUnknownParams drops the fragment", () => {
  assert.equal(
    stripUnknownParams("https://example.com/pricing#plans"),
    "https://example.com/pricing",
  );
  assert.equal(
    stripUnknownParams(
      "https://example.com/cb?utm_source=n&email=x#access_token=secret",
    ),
    "https://example.com/cb?utm_source=n",
  );
});

// Same fallback as parseUrl: referrer is deliberately not URL-validated,
// so "" and anything unparseable pass through rather than throwing.
test("stripUnknownParams passes an unparseable value through", () => {
  assert.equal(stripUnknownParams(""), "");
  assert.equal(stripUnknownParams("not-a-url"), "not-a-url");
});
