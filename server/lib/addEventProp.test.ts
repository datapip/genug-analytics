import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEvent } from "@genug/schema-registry";
import { addEventProp } from "./addEventProp.js";
import type { PropSpec } from "./createEvent.js";

const NEWSLETTER_SIGNUP = {
  _description: "Fired when a visitor submits the newsletter form",
  plan: "string",
  plan_description: "Which plan the visitor was looking at",
  plan_example: "pro",
};

function directory(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-add-prop-"));
  for (const [name, contents] of Object.entries({
    "newsletter_signup.json": NEWSLETTER_SIGNUP,
    ...files,
  })) {
    writeFileSync(
      join(dir, name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return dir;
}

function written(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
    string,
    unknown
  >;
}

function prop(overrides: Partial<PropSpec> = {}): PropSpec {
  return {
    name: "source",
    type: "text",
    optional: false,
    list: false,
    description: "Where the signup was attributed to",
    example: ["newsletter-footer"],
    ...overrides,
  };
}

test("adds a prop, leaving the rest of the file untouched", () => {
  const dir = directory();
  const result = addEventProp(dir, "newsletter_signup", prop());

  assert.equal(result.ok, true);
  const file = written(dir, "newsletter_signup.json");
  assert.equal(file._description, NEWSLETTER_SIGNUP._description);
  assert.equal(file.plan, "string");
  assert.equal(file.source, "string.optional");
  assert.equal(file.source_description, prop().description);
  assert.equal(file.source_example, "newsletter-footer");
  assert.equal(checkEvent(file).ok, true);
});

// The whole point: the checkbox on the form is never trusted.
test("forces the new prop optional even when the spec says required", () => {
  const dir = directory();
  addEventProp(dir, "newsletter_signup", prop({ optional: false }));

  const file = written(dir, "newsletter_signup.json");
  assert.equal(file.source, "string.optional");
});

test("composes list and typed rules the same way createEvent does", () => {
  const dir = directory();
  addEventProp(
    dir,
    "newsletter_signup",
    prop({
      name: "scores",
      type: "number",
      list: true,
      example: ["1", "2"],
    }),
  );

  const file = written(dir, "newsletter_signup.json");
  assert.equal(file.scores, "number.optional.list");
  assert.deepEqual(file.scores_example, [1, 2]);
});

test("refuses a prop name the event already has", () => {
  const dir = directory();
  const result = addEventProp(dir, "newsletter_signup", prop({ name: "plan" }));

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /already a prop/);
  assert.deepEqual(written(dir, "newsletter_signup.json"), NEWSLETTER_SIGNUP);
});

test("refuses an event with no file", () => {
  const dir = directory();
  const result = addEventProp(dir, "does_not_exist", prop());

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /no does_not_exist/);
});

test("refuses to touch a file that is not currently loading", () => {
  const dir = directory({
    "broken.json": { _description: "x", bad: "not-a-real-rule" },
  });
  const result = addEventProp(dir, "broken", prop());

  assert.equal(result.ok, false);
  assert.match(
    result.ok === false ? result.error : "",
    /not currently loading/,
  );
});

test("refuses what the checker rejects, before anything reaches disk", () => {
  const dir = directory();
  const result = addEventProp(
    dir,
    "newsletter_signup",
    prop({ name: "plan_description" }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /Not saved/);
  assert.deepEqual(written(dir, "newsletter_signup.json"), NEWSLETTER_SIGNUP);
});

test("refuses an example that is not the type the prop declares", () => {
  const dir = directory();
  const result = addEventProp(
    dir,
    "newsletter_signup",
    prop({ name: "total", type: "number", example: ["a"] }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /is not a num/);
  assert.deepEqual(written(dir, "newsletter_signup.json"), NEWSLETTER_SIGNUP);
});
