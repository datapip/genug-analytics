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

// What a deployment keeps by default, written out here, so the test
// still checks the default when KEPT_* is set in the shell.
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

// Click ids link a visit to one ad click; a deployment that wants them
// lists them by name.
test("stripUnknownParams drops click ids and ref by default", () => {
  assert.equal(
    stripUnknownParams(
      "https://example.com/p?utm_source=news&gclid=abc&fbclid=d&ref=partner",
      DEFAULTS,
    ),
    "https://example.com/p?utm_source=news",
  );
});

// A newsletter link's email, a login link's token and a search query
// would be shown by get_recent_events and sent to the agent's vendor.
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

test("stripUnknownParams drops a username and password", () => {
  assert.equal(
    stripUnknownParams(
      "https://admin:hunter2@example.com/pricing?utm_source=n",
      DEFAULTS,
    ),
    "https://example.com/pricing?utm_source=n",
  );
  assert.equal(
    stripUnknownParams("https://admin@example.com/", DEFAULTS),
    "https://example.com/",
  );
});

test("stripUnknownParams leaves a URL with no query string alone", () => {
  assert.equal(
    stripUnknownParams("https://example.com/pricing"),
    "https://example.com/pricing",
  );
});

// The fragment is removed by default: some login flows (OAuth) put an
// access_token there.
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

// Like parseUrl: the referrer isn't checked as a URL, so "" and anything
// unparseable are returned unchanged instead of throwing.
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

// The URL parser percent-encodes fragments, so the list entries must be
// encoded too, or #über would never match.
test("a non-ASCII fragment matches whether written plain or encoded", () => {
  for (const written of ["über", "%C3%BCber"]) {
    const parts: KeptUrlParts = {
      params: [],
      hashes: parseKeptHashValues(written),
    };
    assert.equal(
      stripUnknownParams("https://example.com/#über", parts),
      "https://example.com/#%C3%BCber",
      written,
    );
  }
});

// A bare `NAME=` in a compose file means unset, as for TRUST_PROXY.
test("an empty value falls back to the default", () => {
  assert.deepEqual(parseKeptQueryParams(""), DEFAULTS.params);
  assert.deepEqual(parseKeptHashValues("  "), []);
});

// A pattern like utm_* would also keep utm_email=, and a space or comma
// is a typo that would otherwise quietly keep nothing.
test("a glob, an empty entry or a space inside a value refuses to start", () => {
  for (const bad of ["utm_*", "utm_source,,ref", "utm source", "*,ref"]) {
    assert.throws(() => parseKeptQueryParams(bad), /KEPT_QUERY_PARAMS/, bad);
  }
  assert.throws(() => parseKeptHashValues("#"), /KEPT_HASH_VALUES/);
  assert.throws(() => parseKeptHashValues("pricing faq"), /KEPT_HASH_VALUES/);
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
