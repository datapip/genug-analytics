import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { deleteEventFile } from "./deleteEvent.js";

const NEWSLETTER_SIGNUP = {
  _description: "Fired when a visitor submits the newsletter form",
  plan: "string",
  plan_description: "Which plan the visitor was looking at",
  plan_example: "pro",
};

const PAGE_VIEW = {
  _description: "Fired when a visitor views a page",
  _pageView: true,
  page_title: "string",
  page_title_description: "The document's title",
  page_title_example: "Pricing",
};

function directory(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "genug-delete-"));
  for (const [name, contents] of Object.entries({
    "newsletter_signup.json": NEWSLETTER_SIGNUP,
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

test("deletes a custom event's file", () => {
  const dir = directory();
  const result = deleteEventFile(database(), dir, "newsletter_signup");

  assert.equal(result.ok, true);
  assert.equal(existsSync(join(dir, "newsletter_signup.json")), false);
  assert.deepEqual(readdirSync(dir), ["page_view.json"]);
});

test("reports how many stored rows are left behind", () => {
  const db = database();
  storeEvents(db, "newsletter_signup", 5);
  const result = deleteEventFile(db, directory(), "newsletter_signup");

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.storedCount : -1, 5);
});

test("reports zero when nothing was ever stored under the name", () => {
  const result = deleteEventFile(database(), directory(), "newsletter_signup");

  assert.equal(result.ok, true);
  assert.equal(result.ok === true ? result.storedCount : -1, 0);
});

// The whole point of this function's design: it does not know or care
// whether an event carries a role tag. routes/cockpit.ts is what checks
// the consequence, via the real registry loader, and calls restore()
// if that loader refuses the result — see the wiring tests for the
// end-to-end version of that (a real collision, a real 409, a real
// restored file).
test("deletes an event carrying a role tag without refusing", () => {
  const dir = directory();
  const result = deleteEventFile(database(), dir, "page_view");

  assert.equal(result.ok, true);
  assert.equal(existsSync(join(dir, "page_view.json")), false);
});

test("restore() puts back the exact bytes that were deleted", () => {
  const dir = directory();
  const before = readFileSync(join(dir, "page_view.json"), "utf8");
  const result = deleteEventFile(database(), dir, "page_view");

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(existsSync(join(dir, "page_view.json")), false);
  result.restore();
  assert.equal(existsSync(join(dir, "page_view.json")), true);
  assert.equal(readFileSync(join(dir, "page_view.json"), "utf8"), before);
});

// A file already broken before the request is not a file the server is
// routing anything through by name — there is nothing left to protect,
// so this stays deletable rather than stuck.
test("allows deleting a file that does not currently load", () => {
  const dir = directory({
    "broken.json": { _description: "x", bad: "not-a-real-rule" },
  });
  const result = deleteEventFile(database(), dir, "broken");

  assert.equal(result.ok, true);
  assert.equal(existsSync(join(dir, "broken.json")), false);
});

test("refuses an event with no file", () => {
  const result = deleteEventFile(database(), directory(), "does_not_exist");

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : "", /no does_not_exist/);
});

test("refuses a name that could not be a file", () => {
  for (const name of ["../escape", "news letter", ""]) {
    const result = deleteEventFile(database(), directory(), name);
    assert.equal(result.ok, false, `"${name}" should be refused`);
  }
});
