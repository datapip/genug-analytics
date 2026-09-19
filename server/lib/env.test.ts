import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requireEnv,
  parsePort,
  parseTrustProxy,
  parseReadOnly,
} from "./env.js";

test("requireEnv returns the value when set", () => {
  process.env.TEST_REQUIRE_ENV = "some-value";
  try {
    assert.equal(requireEnv("TEST_REQUIRE_ENV"), "some-value");
  } finally {
    delete process.env.TEST_REQUIRE_ENV;
  }
});

test("requireEnv throws a clear error when unset", () => {
  delete process.env.TEST_REQUIRE_ENV_MISSING;
  assert.throws(
    () => requireEnv("TEST_REQUIRE_ENV_MISSING"),
    /TEST_REQUIRE_ENV_MISSING environment variable is required/,
  );
});

test("parsePort defaults to 3000 when unset", () => {
  assert.equal(parsePort(undefined), 3000);
});

test("parsePort parses a valid port", () => {
  assert.equal(parsePort("8080"), 8080);
});

test("parsePort throws for non-numeric, non-integer, zero, or out-of-range values", () => {
  assert.throws(() => parsePort("not-a-number"));
  assert.throws(() => parsePort("3000.5"));
  assert.throws(() => parsePort("0"));
  assert.throws(() => parsePort("70000"));
  assert.throws(() => parsePort("-1"));
});

test("parseTrustProxy trusts nobody when unset or empty", () => {
  assert.equal(parseTrustProxy(undefined), 0);
  assert.equal(parseTrustProxy(""), 0);
});

test("parseTrustProxy parses a hop count", () => {
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("2"), 2);
  assert.equal(parseTrustProxy("0"), 0);
});

test("parseTrustProxy throws rather than quietly trusting nobody", () => {
  for (const value of ["true", "yes", "-1", "1.5", "11"]) {
    assert.throws(
      () => parseTrustProxy(value),
      /TRUST_PROXY must be an integer between 0 and 10/,
      `"${value}" should be refused`,
    );
  }
});

test("parseReadOnly is off unless set to exactly true", () => {
  assert.equal(parseReadOnly(undefined), false);
  assert.equal(parseReadOnly(""), false);
  assert.equal(parseReadOnly("false"), false);
  assert.equal(parseReadOnly("true"), true);
});

// A typo must not silently mean "writes allowed" on a deployment whose
// key is public.
test("parseReadOnly refuses anything that is not true or false", () => {
  for (const value of ["1", "yes", "TRUE", "ture"]) {
    assert.throws(() => parseReadOnly(value), /READ_ONLY must be/);
  }
});
