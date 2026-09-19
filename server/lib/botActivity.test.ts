import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertBotActivity } from "../db/botActivity.js";
import {
  createBotActivityCounter,
  recordBotHit,
  drainBotHits,
  getBotActivityCount,
} from "./botActivity.js";

function setupDb() {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

const PERIOD = {
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-01T23:59:59.999Z",
};

test("recordBotHit increments the counter", () => {
  const counter = createBotActivityCounter();
  recordBotHit(counter);
  recordBotHit(counter);
  assert.equal(counter.count, 2);
});

test("drainBotHits returns the count and resets it to 0", () => {
  const counter = createBotActivityCounter();
  recordBotHit(counter);
  recordBotHit(counter);
  recordBotHit(counter);

  assert.equal(drainBotHits(counter), 3);
  assert.equal(counter.count, 0);
  assert.equal(drainBotHits(counter), 0);
});

test("two counters don't share state", () => {
  const a = createBotActivityCounter();
  const b = createBotActivityCounter();
  recordBotHit(a);
  assert.equal(a.count, 1);
  assert.equal(b.count, 0);
});

test("getBotActivityCount sums hourly rows within a period", () => {
  const db = setupDb();
  insertBotActivity(db, "2026-01-01T09:00:00.000Z", 5);
  insertBotActivity(db, "2026-01-01T10:00:00.000Z", 3);
  insertBotActivity(db, "2025-12-31T23:00:00.000Z", 100); // before PERIOD

  assert.equal(getBotActivityCount(db, PERIOD), 8);
});

test("getBotActivityCount is 0 for an empty table", () => {
  const db = setupDb();
  assert.equal(getBotActivityCount(db, PERIOD), 0);
});
