import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEvent } from "./checkEvent.js";

const VALID = {
  _description: "Fired when a visitor views a page",
  _pageView: true,
  page_title: "string",
  page_title_description: "The document's title",
  page_title_example: "Pricing — Genug",
};

function errors(value: unknown): string[] {
  const result = checkEvent(value);
  assert.equal(result.ok, false, "expected this event to be rejected");
  return result.errors;
}

// A copy of VALID with one key removed. Destructuring-to-omit reads
// fine but leaves a variable nothing uses, which the lint rule
// (rightly) does not distinguish from a genuine leftover.
function without(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...VALID };
  delete copy[key];
  return copy;
}

function pass(value: unknown) {
  const result = checkEvent(value);
  assert.equal(
    result.ok,
    true,
    `expected this event to be accepted, got: ${result.ok ? "" : result.errors.join(" / ")}`,
  );
  return result.event;
}

test("accepts a well-formed event and reads its rules", () => {
  const event = pass(VALID);
  assert.equal(event.description, "Fired when a visitor views a page");
  assert.equal(event.pageView, true);
  assert.equal(event.outboundClick, false);
  assert.equal(event.conversion, false);
  assert.deepEqual(event.props.page_title!.rule, {
    type: "string",
    required: true,
    list: false,
    maxLength: 512,
  });
  assert.equal(event.props.page_title!.example, "Pricing — Genug");
});

test("_conversion defaults to false and can be set true", () => {
  assert.equal(pass(VALID).conversion, false);
  assert.equal(pass({ ...VALID, _conversion: true }).conversion, true);
});

test("rejects a _conversion that isn't a boolean", () => {
  assert.match(
    errors({ ...VALID, _conversion: "yes" }).join(),
    /"_conversion" must be true or false/,
  );
});

test("an event with no props at all is fine", () => {
  const event = pass({
    _description: "Fired when the newsletter form is submitted",
  });
  assert.deepEqual(event.props, {});
});

// `_note` is the format's comment. Plain JSON has none, and a JSONC
// parser was not worth a dependency.
test("_note is allowed and never reaches the registry", () => {
  const event = pass({
    ...VALID,
    _note: "why this exists",
    page_title_note: "x",
  });
  assert.deepEqual(Object.keys(event.props), ["page_title"]);
  assert.equal("_note" in event, false);
});

// Rule 7.
test("requires a description on the event", () => {
  assert.match(
    errors(without("_description")).join(),
    /"_description" is missing/,
  );

  assert.match(
    errors({ ...VALID, _description: "  " }).join(),
    /"_description" must be a non-empty string/,
  );
});

// Rule 9: the case this exists for is a typo in a metadata name. Ignored
// silently, the event registers without the thing its author wrote.
test("rejects an unknown underscore key and lists the valid ones", () => {
  const message = errors({ ...VALID, _categroy: "technical" }).join();
  assert.match(message, /unknown event key "_categroy"/);
  assert.match(message, /_description, _note/);
});

test("rejects a role tag that isn't a boolean", () => {
  assert.match(
    errors({ ...VALID, _pageView: "yes" }).join(),
    /"_pageView" must be true or false/,
  );
});

// Rule 5.
test("requires a description and an example on every prop", () => {
  assert.match(
    errors(without("page_title_description")).join(),
    /prop "page_title": "page_title_description" is missing/,
  );
  assert.match(
    errors(without("page_title_example")).join(),
    /needs "page_title_example"/,
  );

  assert.match(
    errors({ ...VALID, page_title_description: "" }).join(),
    /must be a non-empty string/,
  );
});

// Rule 6: the example is shown to the agent as representative, so one
// the schema would itself reject is a lie about the data.
test("rejects an example that doesn't obey its own rule", () => {
  assert.match(
    errors({ ...VALID, page_title_example: 42 }).join(),
    /"page_title_example" must be a string/,
  );
  assert.match(
    errors({ ...VALID, page_title_example: "x".repeat(513) }).join(),
    /is 513 characters, over this prop's limit of 512/,
  );
  assert.match(
    errors({
      ...VALID,
      order_total: "number",
      order_total_description: "Value of the order",
      order_total_example: "12.50",
    }).join(),
    /"order_total_example" must be a finite number/,
  );
});

test("a long string prop accepts an example the short cap would reject", () => {
  const event = pass({
    ...VALID,
    page_title: "string.long",
    page_title_example: "x".repeat(2000),
  });
  assert.deepEqual(event.props.page_title!.rule, {
    type: "string",
    required: true,
    list: false,
    maxLength: 2048,
  });
});

// Rule 10. Guessing which of the two readings was meant is worse than
// saying the name is unavailable.
test("rejects metadata whose prop isn't declared", () => {
  const message = errors({ ...VALID, page_titel_example: "typo" }).join();
  assert.match(message, /"page_titel_example" describes a prop "page_titel"/);
  assert.match(message, /cannot be called that/);
});

test("rejects a prop name json_extract could not read back", () => {
  assert.match(
    errors({
      ...VALID,
      "product.id": "string",
      "product.id_description": "The id",
      "product.id_example": "abc",
    }).join(),
    /may only contain lowercase letters, digits and underscores/,
  );
});

// The audience is someone editing a file on a server, who would
// otherwise fix one typo per restart.
test("reports every problem at once, not just the first", () => {
  const found = errors({
    _categroy: "technical",
    page_title: "string.requried",
  });
  assert.equal(found.length, 3, found.join(" / "));
});

test("rejects anything that isn't a JSON object", () => {
  assert.match(errors([VALID]).join(), /must be a JSON object/);
  assert.match(errors("page_view").join(), /must be a JSON object/);
  assert.match(errors(null).join(), /must be a JSON object/);
});

test("a list prop's example must be an array of matching values", () => {
  const event = pass({
    ...VALID,
    tags: "string.list",
    tags_description: "Topics this article is filed under",
    tags_example: ["pricing", "analytics"],
  });
  assert.deepEqual(event.props.tags!.example, ["pricing", "analytics"]);

  const withExample = (tags_example: unknown) => ({
    ...VALID,
    tags: "string.list",
    tags_description: "Topics this article is filed under",
    tags_example,
  });
  assert.match(
    errors(withExample("pricing")).join(),
    /must be an array, because this prop is declared as a list/,
  );
  assert.match(
    errors(withExample(["pricing", 7])).join(),
    /value 2 must be a string/,
  );
  assert.match(
    errors(withExample(["x".repeat(513)])).join(),
    /value 1 is 513 characters, over this prop's limit of 512/,
  );
  // The prop itself may arrive empty; the example may not.
  assert.match(errors(withExample([])).join(), /must have at least one value/);
  assert.match(
    errors(withExample(Array(51).fill("x"))).join(),
    /has 51 values, over the limit of 50/,
  );
});

// The mirror of the list case: a scalar prop given an array.
test("a non-list prop's example may not be an array", () => {
  assert.match(
    errors({ ...VALID, page_title_example: ["Pricing"] }).join(),
    /"page_title_example" must be a string/,
  );
});
