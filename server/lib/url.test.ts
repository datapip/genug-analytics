import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeKeptQueryParams,
  isKeptQueryParam,
  parseKeptHashValues,
  parseKeptQueryParams,
  parseUrl,
  stripUnknownParams,
  type KeptUrlParts,
} from "./url.js";

// What an unconfigured deployment keeps, spelled out rather than read
// from the module, so a test run with KEPT_* set in the shell still
// tests the default.
const DEFAULTS: KeptUrlParts = {
  params: parseKeptQueryParams(undefined),
  hashes: parseKeptHashValues(undefined),
};

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

test("stripUnknownParams keeps utm parameters by default", () => {
  assert.equal(
    stripUnknownParams(
      "https://example.com/p?utm_source=news&utm_Medium=email&utm_id=7",
      DEFAULTS,
    ),
    "https://example.com/p?utm_source=news&utm_Medium=email&utm_id=7",
  );
});

// Each ties a visit to one ad click on the platform's side; a
// deployment that wants them opts in by name.
test("stripUnknownParams drops click ids and ref by default", () => {
  assert.equal(
    stripUnknownParams(
      "https://example.com/p?utm_source=news&gclid=abc&fbclid=d&ref=partner",
      DEFAULTS,
    ),
    "https://example.com/p?utm_source=news",
  );
});

// The reason this function exists: a newsletter link's address, a magic
// link's token and a search page's typed query are all read back
// verbatim by get_recent_events, and reach the agent's model vendor.
test("stripUnknownParams drops everything else", () => {
  assert.equal(
    stripUnknownParams("https://example.com/reset?token=secret123", DEFAULTS),
    "https://example.com/reset",
  );
  assert.equal(
    stripUnknownParams(
      "https://example.com/?email=a%40b.com&utm_source=news",
      DEFAULTS,
    ),
    "https://example.com/?utm_source=news",
  );
  assert.equal(
    stripUnknownParams(
      "https://example.com/search?q=how+do+i+cancel",
      DEFAULTS,
    ),
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
test("stripUnknownParams drops the fragment by default", () => {
  assert.equal(
    stripUnknownParams("https://example.com/pricing#plans", DEFAULTS),
    "https://example.com/pricing",
  );
  assert.equal(
    stripUnknownParams(
      "https://example.com/cb?utm_source=n&email=x#access_token=secret",
      DEFAULTS,
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

test("a configured list replaces the default, matched case-insensitively", () => {
  const parts: KeptUrlParts = {
    params: parseKeptQueryParams(" GCLID , utm_source,ref"),
    hashes: [],
  };
  assert.deepEqual(parts.params, ["gclid", "utm_source", "ref"]);
  assert.equal(
    stripUnknownParams(
      "https://example.com/p?gclid=a&utm_medium=b&Ref=c&email=d",
      parts,
    ),
    "https://example.com/p?gclid=a&Ref=c",
  );
  assert.equal(isKeptQueryParam("UTM_SOURCE", parts), true);
  assert.equal(isKeptQueryParam("utm_medium", parts), false);
});

test('"*" keeps every parameter and every fragment', () => {
  const parts: KeptUrlParts = {
    params: parseKeptQueryParams("*"),
    hashes: parseKeptHashValues(" * "),
  };
  assert.equal(
    stripUnknownParams("https://example.com/p?email=a%40b.com&q=x#t=1", parts),
    "https://example.com/p?email=a%40b.com&q=x#t=1",
  );
  assert.equal(isKeptQueryParam("anything", parts), true);
});

test("a fragment list keeps exactly those fragments", () => {
  const parts: KeptUrlParts = {
    params: [],
    hashes: parseKeptHashValues("#pricing,faq"),
  };
  assert.deepEqual(parts.hashes, ["pricing", "faq"]);
  assert.equal(
    stripUnknownParams("https://example.com/#pricing", parts),
    "https://example.com/#pricing",
  );
  assert.equal(
    stripUnknownParams("https://example.com/#Pricing", parts),
    "https://example.com/",
    "an anchor id is case-sensitive",
  );
  assert.equal(
    stripUnknownParams("https://example.com/#access_token=x", parts),
    "https://example.com/",
  );
});

// A bare `NAME=` in a compose file means unset, as for TRUST_PROXY.
test("an empty value falls back to the default", () => {
  assert.deepEqual(parseKeptQueryParams(""), DEFAULTS.params);
  assert.deepEqual(parseKeptHashValues("  "), []);
});

// A glob would keep utm_email= too, and a stray space or comma is a
// typo that would otherwise silently keep nothing under that name.
test("a glob, an empty entry or a space inside a value refuses to start", () => {
  for (const bad of ["utm_*", "utm_source,,ref", "utm source", "*,ref"]) {
    assert.throws(() => parseKeptQueryParams(bad), /KEPT_QUERY_PARAMS/, bad);
  }
  assert.throws(() => parseKeptHashValues("#"), /KEPT_HASH_VALUES/);
});

test("describeKeptQueryParams names the list, or says everything is kept", () => {
  assert.equal(
    describeKeptQueryParams({ params: ["utm_source", "ref"], hashes: [] }),
    "utm_source, ref",
  );
  assert.match(
    describeKeptQueryParams({ params: "*", hashes: [] }),
    /keeps them all/,
  );
});
