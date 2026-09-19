import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "./migrations.js";
import { insertBotActivity } from "./botActivity.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

test("insertBotActivity stores ts and count", () => {
  const db = setupDb();
  insertBotActivity(db, "2026-01-01T00:00:00.000Z", 7);

  const row = db.prepare("SELECT * FROM bot_activity").get() as {
    ts: string;
    count: number;
  };
  assert.equal(row.ts, "2026-01-01T00:00:00.000Z");
  assert.equal(row.count, 7);
});
