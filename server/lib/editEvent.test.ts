import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { editEventFile, type EventEdit } from "./editEvent.js";

const PAGE_VIEW = {
  _description: "Fired when a visitor views a page",
  _pageView: true,
  _note: "A comment that nothing reads",
  page_title: "string",
  page_title_description: "The document's title",
  page_title_example: "Pricing",
  order_total: "number",
  order_total_description: "Nonsense on a page view, but a number prop",
  order_total_example: 49.9,
  tags: "string.list",
  tags_description: "Tags on the page",
  tags_example: ["news"],
};

function directory(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-edit-"));
  for (const [name, contents] of Object.entries({
    "page_view.json": PAGE_VIEW,
    ...files,
  })) {
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

function countStored(db: Database.Database, event: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE event = ?`)
      .get(event) as { c: number }
  ).c;
}

function edit(overrides: Partial<EventEdit> = {}): EventEdit {
  return {
    name: "page_view",
    description: "Fired when a visitor views a page",
    props: {},
    renameStoredEvents: false,
    ...overrides,
  };
}

function readBack(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

test("rewrites the description, leaving everything else", () => {
  const dir = directory();
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({ description: "A page was looked at" }),
  );

  assert.deepEqual(result, { ok: true, name: "page_view", movedRows: 0 });
  const file = readBack(dir, "page_view");
  assert.equal(file._description, "A page was looked at");
  // The parts this editor must never touch, because they decide whether
  // an incoming event is accepted and which event fills the page-view
  // role.
  assert.equal(file._pageView, true);
  assert.equal(file._note, "A comment that nothing reads");
  assert.equal(file.page_title, "string");
  assert.equal(file.tags, "string.list");
});

test("rewrites a prop's description and example", () => {
  const dir = directory();
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({
      props: {
        page_title: { description: "Whatever the tab says", example: "Preise" },
      },
    }),
  );

  assert.equal(result.ok, true);
  const file = readBack(dir, "page_view");
  assert.equal(file.page_title_description, "Whatever the tab says");
  assert.equal(file.page_title_example, "Preise");
});

// A text input hands back text. For a plain string prop that *is* the
// value; for anything else it has to be read as JSON, or every number
// example would silently become a string and fail the checker.
test("reads a non-string example as JSON, and a string one as typed", () => {
  const dir = directory();
  editEventFile(
    database(),
    dir,
    "page_view",
    edit({
      props: {
        page_title: { description: "The document's title", example: "49.9" },
        order_total: {
          description: "Order total including tax",
          example: "12",
        },
        tags: { description: "Tags on the page", example: '["a", "b"]' },
      },
    }),
  );

  const file = readBack(dir, "page_view");
  assert.equal(file.page_title_example, "49.9", "a string stays text");
  assert.equal(file.order_total_example, 12);
  assert.deepEqual(file.tags_example, ["a", "b"]);
});

test("refuses an example that is not valid JSON for its type", () => {
  const dir = directory();
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({
      props: {
        order_total: {
          description: "Order total including tax",
          example: "a lot",
        },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.match(
    result.ok ? "" : result.error,
    /example for "order_total".*a number, like 49\.9/s,
  );
  assert.equal(readBack(dir, "page_view").order_total_example, 49.9);
});

// The line this editor is built around: prose in, structure untouched.
test("refuses a prop the event does not have", () => {
  const dir = directory();
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({
      props: { smuggled_in: { description: "A brand new prop", example: "x" } },
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /not a prop of page_view/);
  assert.equal("smuggled_in" in readBack(dir, "page_view"), false);
});

test("renames the file and keeps the role tag with it", () => {
  const dir = directory();
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({ name: "seitenaufruf" }),
  );

  assert.deepEqual(result, { ok: true, name: "seitenaufruf", movedRows: 0 });
  assert.deepEqual(readdirSync(dir), ["seitenaufruf.json"]);
  assert.equal(readBack(dir, "seitenaufruf")._pageView, true);
});

test("moves the stored events when asked, and reports how many", () => {
  const dir = directory();
  const db = database();
  storeEvents(db, "page_view", 3);

  const result = editEventFile(
    db,
    dir,
    "page_view",
    edit({ name: "seitenaufruf", renameStoredEvents: true }),
  );

  assert.deepEqual(result, { ok: true, name: "seitenaufruf", movedRows: 3 });
  assert.equal(countStored(db, "page_view"), 0);
  assert.equal(countStored(db, "seitenaufruf"), 3);
});

// Declining is a real choice, not an oversight — but it is the choice
// that strands rows, which is why the cockpit ticks the box by default.
test("leaves the stored events alone when not asked", () => {
  const dir = directory();
  const db = database();
  storeEvents(db, "page_view", 3);

  const result = editEventFile(
    db,
    dir,
    "page_view",
    edit({ name: "seitenaufruf" }),
  );

  assert.equal(result.ok, true);
  assert.equal(countStored(db, "page_view"), 3);
  assert.equal(countStored(db, "seitenaufruf"), 0);
});

// Rows under the target name are some earlier event's history — a file
// of that name would have been caught separately. Merging them cannot
// be undone, so it is refused rather than done quietly.
test("refuses to merge history into rows an earlier rename left behind", () => {
  const dir = directory();
  const db = database();
  storeEvents(db, "page_view", 3);
  storeEvents(db, "seitenaufruf", 5);

  const result = editEventFile(
    db,
    dir,
    "page_view",
    edit({ name: "seitenaufruf", renameStoredEvents: true }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /5 events are already stored/);
  // Nothing at all happened: not the rows, and not the file either.
  assert.equal(countStored(db, "page_view"), 3);
  assert.equal(countStored(db, "seitenaufruf"), 5);
  assert.deepEqual(readdirSync(dir), ["page_view.json"]);
});

test("refuses to rename onto an event that already exists", () => {
  const dir = directory({ "order_placed.json": PAGE_VIEW });
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({ name: "order_placed" }),
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /already exists/);
  assert.deepEqual(readdirSync(dir).sort(), [
    "order_placed.json",
    "page_view.json",
  ]);
});

test("refuses a name the filesystem cannot hold as an event", () => {
  const dir = directory();
  for (const name of ["page view", "../escape", "page-view", ""]) {
    const result = editEventFile(database(), dir, "page_view", edit({ name }));
    assert.equal(result.ok, false, `expected ${JSON.stringify(name)} to fail`);
  }
  assert.deepEqual(readdirSync(dir), ["page_view.json"]);
});

// The route takes the current name straight out of the URL, and Express
// decodes %2F before we see it, so an unchecked name here is a path out
// of the events directory — one a rename would go on to unlink.
test("refuses a current name that is a path rather than an event", () => {
  const dir = directory();
  const outsideName = `genug-outside-${process.pid}`;
  const outsidePath = join(dir, "..", `${outsideName}.json`);
  writeFileSync(outsidePath, JSON.stringify(PAGE_VIEW));

  try {
    for (const name of [`../${outsideName}`, "page view", "page-view", ""]) {
      const result = editEventFile(database(), dir, name, edit());
      assert.equal(
        result.ok,
        false,
        `expected ${JSON.stringify(name)} to be refused`,
      );
      assert.match(
        result.ok === false ? result.error : "",
        /cannot be an event name/,
      );
    }
    assert.equal(
      existsSync(outsidePath),
      true,
      "a file outside the events directory must be left alone",
    );
  } finally {
    rmSync(outsidePath, { force: true });
  }
});

// Nothing reaches disk until the whole edited file has passed the
// loader's own checker, so a rejected edit costs nothing rather than
// leaving a file the next reload refuses.
test("writes nothing when the result would not load", () => {
  const dir = directory();
  const result = editEventFile(
    database(),
    dir,
    "page_view",
    edit({ description: "  " }),
  );

  assert.equal(result.ok, false);
  assert.equal(
    readBack(dir, "page_view")._description,
    "Fired when a visitor views a page",
  );
});

test("refuses to edit a file that is not loading in the first place", () => {
  const dir = directory({ "broken.json": "{ not json" });
  const result = editEventFile(database(), dir, "broken", edit());

  assert.equal(result.ok, false);
  assert.match(
    result.ok ? "" : result.error,
    /could not be read|not currently/,
  );
});

test("reports a name that has no file", () => {
  const result = editEventFile(database(), directory(), "nothing_here", edit());
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /no nothing_here\.json/);
});
