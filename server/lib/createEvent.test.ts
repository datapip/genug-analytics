import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { checkEvent } from "@genug/schema-registry";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import {
  createEventFile,
  type EventCreate,
  type PropSpec,
} from "./createEvent.js";

function directory(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-create-"));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(
      join(dir, name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  return dir;
}

function database(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function storeEvents(db: Database.Database, event: string, count: number) {
  for (let i = 0; i < count; i++) {
    insertEvent(db, {
      event,
      visitorId: `v${i}`,
      sessionId: `s${i}`,
      ts: new Date().toISOString(),
      url: "https://example.com/x",
      props: {},
    });
  }
}

function prop(overrides: Partial<PropSpec> = {}): PropSpec {
  return {
    name: "plan",
    type: "text",
    optional: false,
    list: false,
    description: "Which plan the visitor was looking at",
    example: ["pro"],
    ...overrides,
  };
}

function create(overrides: Partial<EventCreate> = {}): EventCreate {
  return {
    name: "newsletter_signup",
    description: "Fired when a visitor submits the newsletter form",
    props: [prop()],
    ...overrides,
  };
}

function written(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
    string,
    unknown
  >;
}

test("writes a file the loader accepts", () => {
  const dir = directory();
  const result = createEventFile(database(), dir, create());

  assert.equal(result.ok, true);
  assert.deepEqual(readdirSync(dir), ["newsletter_signup.json"]);

  const file = written(dir, "newsletter_signup.json");
  assert.equal(
    checkEvent(file).ok,
    true,
    "a file this wrote must be a file that loads",
  );
  assert.equal(file._description, create().description);
  assert.equal(file.plan, "string");
  assert.equal(file.plan_description, "Which plan the visitor was looking at");
  assert.equal(file.plan_example, "pro");
});

// The point of the whole design: the browser sends a type and two
// booleans, and the rule string is composed here.
test("composes each rule string from the type and the checkboxes", () => {
  const dir = directory();
  const result = createEventFile(
    database(),
    dir,
    create({
      props: [
        prop({ name: "title", type: "text" }),
        prop({ name: "body", type: "longText" }),
        prop({ name: "total", type: "number", example: ["49.9"] }),
        prop({ name: "paid", type: "boolean", example: ["true"] }),
        prop({ name: "note", type: "text", optional: true }),
        prop({ name: "tags", type: "text", list: true, example: ["a", "b"] }),
        prop({
          name: "scores",
          type: "number",
          optional: true,
          list: true,
          example: ["1", "2"],
        }),
      ],
    }),
  );

  assert.equal(result.ok, true);
  const file = written(dir, "newsletter_signup.json");
  assert.equal(file.title, "string");
  assert.equal(file.body, "string.long");
  assert.equal(file.total, "number");
  assert.equal(file.paid, "boolean");
  assert.equal(file.note, "string.optional");
  assert.equal(file.tags, "string.list");
  assert.equal(file.scores, "number.optional.list");
});

test("reads each example as the type it was declared with", () => {
  const dir = directory();
  createEventFile(
    database(),
    dir,
    create({
      props: [
        prop({ name: "total", type: "number", example: ["49.9"] }),
        prop({ name: "paid", type: "boolean", example: ["false"] }),
        prop({ name: "tags", type: "text", list: true, example: ["a", "b"] }),
        prop({
          name: "scores",
          type: "number",
          list: true,
          example: ["1", "2"],
        }),
      ],
    }),
  );

  const file = written(dir, "newsletter_signup.json");
  assert.equal(file.total_example, 49.9);
  assert.equal(file.paid_example, false);
  assert.deepEqual(file.tags_example, ["a", "b"]);
  assert.deepEqual(file.scores_example, [1, 2]);
});

test("never writes a role tag, whatever it is asked for", () => {
  const dir = directory();
  createEventFile(database(), dir, create());
  const file = written(dir, "newsletter_signup.json");

  assert.equal("_pageView" in file, false);
  assert.equal("_automaticOutboundClick" in file, false);
  assert.equal("_automaticFileDownload" in file, false);
});

test("refuses a name an event already has, and writes nothing", () => {
  const dir = directory({ "newsletter_signup.json": { _description: "x" } });
  const result = createEventFile(database(), dir, create());

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /already exists/);
  assert.deepEqual(written(dir, "newsletter_signup.json"), {
    _description: "x",
  });
});

test("refuses a name that could not be a file", () => {
  for (const name of ["../escape", "news letter", "news-letter", ""]) {
    const dir = directory();
    const result = createEventFile(database(), dir, create({ name }));
    assert.equal(result.ok, false, `"${name}" should be refused`);
    assert.deepEqual(readdirSync(dir), [], "nothing should be written");
  }
});

test("refuses two props of one name rather than collapsing them", () => {
  const dir = directory();
  const result = createEventFile(
    database(),
    dir,
    create({ props: [prop({ name: "plan" }), prop({ name: "plan" })] }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /declared twice/);
  assert.deepEqual(readdirSync(dir), []);
});

test("refuses an example that is not the type the prop declares", () => {
  const dir = directory();

  const notANumber = createEventFile(
    database(),
    dir,
    create({
      props: [prop({ name: "total", type: "number", example: ["a"] })],
    }),
  );
  assert.equal(notANumber.ok, false);
  assert.match(notANumber.ok === false ? notANumber.error : "", /is not a num/);

  const notABoolean = createEventFile(
    database(),
    dir,
    create({
      props: [prop({ name: "paid", type: "boolean", example: ["yes"] })],
    }),
  );
  assert.equal(notABoolean.ok, false);
  assert.match(
    notABoolean.ok === false ? notABoolean.error : "",
    /true or false/,
  );

  assert.deepEqual(readdirSync(dir), [], "nothing should be written");
});

// checkEvent owns rules this function does not know about. It runs
// before the write, so a rejected creation costs nothing.
test("refuses what the checker rejects, before anything reaches disk", () => {
  const dir = directory();
  const result = createEventFile(
    database(),
    dir,
    create({ props: [prop({ name: "plan_description" })] }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /Not created/);
  assert.deepEqual(readdirSync(dir), []);
});

test("an event with no props at all is allowed", () => {
  const dir = directory();
  const result = createEventFile(database(), dir, create({ props: [] }));

  assert.equal(result.ok, true);
  assert.equal(checkEvent(written(dir, "newsletter_signup.json")).ok, true);
});

test("reports the stranded rows the new event inherits", () => {
  const db = database();
  storeEvents(db, "newsletter_signup", 4);
  const result = createEventFile(db, directory(), create());

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.adoptedRows : -1, 4);
});

test("reports no inherited rows when the name is unused", () => {
  const db = database();
  storeEvents(db, "something_else", 3);
  const result = createEventFile(db, directory(), create());

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.adoptedRows : -1, 0);
});
