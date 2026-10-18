import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRule,
  MAX_PROP_STRING_LENGTH,
  DEFAULT_PROP_STRING_LENGTH,
} from "./parseRule.js";

function ok(value: unknown) {
  const result = parseRule(value);
  assert.equal(result.ok, true, `expected ${JSON.stringify(value)} to parse`);
  return result.rule;
}

function error(value: unknown): string {
  const result = parseRule(value);
  assert.equal(
    result.ok,
    false,
    `expected ${JSON.stringify(value)} to be rejected`,
  );
  return result.error;
}

// The common case, a required text prop of normal length, needs no
// modifiers: just "string".
test("a bare type means required, and short for a string", () => {
  assert.deepEqual(ok("string"), {
    type: "string",
    required: true,
    list: false,
    maxLength: DEFAULT_PROP_STRING_LENGTH,
  });
  assert.deepEqual(ok("number"), {
    type: "number",
    required: true,
    list: false,
  });
  assert.deepEqual(ok("boolean"), {
    type: "boolean",
    required: true,
    list: false,
  });
});

test("long raises the cap to the URL ceiling", () => {
  assert.deepEqual(ok("string.long"), {
    type: "string",
    required: true,
    list: false,
    maxLength: MAX_PROP_STRING_LENGTH,
  });
  assert.deepEqual(ok("string.short"), {
    type: "string",
    required: true,
    list: false,
    maxLength: DEFAULT_PROP_STRING_LENGTH,
  });
});

test("optional flips required, explicitly saying required changes nothing", () => {
  assert.equal(ok("string.optional").required, false);
  assert.equal(ok("number.optional").required, false);
  assert.equal(ok("string.required").required, true);
});

// Modifiers may come in any order; only the type must be first.
test("modifiers may be written in either order", () => {
  assert.deepEqual(ok("string.long.optional"), ok("string.optional.long"));
});

// An unknown type is named, with the valid ones.
test("rejects an unknown type and lists the real ones", () => {
  const message = error("str");
  assert.match(message, /unknown type "str" — /, 'no redundant `in "str"`');
  assert.match(message, /string, number, boolean/);
  assert.match(
    error("strng.optional"),
    /unknown type "strng" in "strng.optional"/,
    "but the whole rule is quoted back when it says more than the type",
  );
  assert.match(error("String"), /unknown type/, "types are case-sensitive");
  assert.match(error(""), /unknown type/);
});

// An unknown type or modifier is named in the error, so someone editing
// the file knows what to fix.
test("rejects an unknown rule word, naming it and the valid ones", () => {
  const message = error("string.requried");
  assert.match(message, /unknown rule word "requried"/);
  assert.match(message, /"string.requried"/);
  assert.match(message, /required, optional, short, long, list/);
});

// Contradictory or repeated words are rejected.
test("rejects contradictory and repeated words", () => {
  assert.match(
    error("string.required.optional"),
    /both "required" and "optional"/,
  );
  assert.match(error("string.short.long"), /both "short" and "long"/);
  assert.match(error("string.long.long"), /repeats "long"/);
});

// short and long only work with string; rejected rather than ignored,
// so the mistake is noticed.
test("rejects a length word on a type that has no length", () => {
  assert.match(error("number.long"), /sets a length on a number/);
  assert.match(error("boolean.short"), /sets a length on a boolean/);
});

test("rejects a rule that isn't a string at all", () => {
  assert.match(error(512), /expected a rule string/);
  assert.match(error({ type: "string" }), /got an object/);
  assert.match(error(["string"]), /got an array/);
  assert.match(error(null), /got null/);
});

// With `in`, these built-in object keys would be accepted as valid
// modifiers.
test("inherited object properties are not rule words", () => {
  assert.match(error("string.constructor"), /unknown rule word/);
  assert.match(error("string.toString"), /unknown rule word/);
});

// A list holds several values of one type, such as tags on a post. The
// length limit applies to each value; the list itself is limited in
// how many values it holds.
test("list marks the prop as holding several values", () => {
  assert.deepEqual(ok("string.list"), {
    type: "string",
    required: true,
    list: true,
    maxLength: DEFAULT_PROP_STRING_LENGTH,
  });
  assert.deepEqual(ok("number.list"), {
    type: "number",
    required: true,
    list: true,
  });
  assert.deepEqual(ok("number.list.optional"), {
    type: "number",
    required: false,
    list: true,
  });
  assert.deepEqual(ok("string.long.list"), ok("string.list.long"));
});

test("rejects a repeated list word", () => {
  assert.match(error("string.list.list"), /repeats "list"/);
});
