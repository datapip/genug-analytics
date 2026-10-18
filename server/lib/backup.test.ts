import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import {
  runBackup,
  pruneOldBackups,
  parseLocalBackupsEnabled,
} from "./backup.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "genug-backup-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A copy that would fill the disk is skipped with a reason, and nothing
// half-written is left behind.
test("runBackup skips a copy the disk has no room for", async () => {
  await withTempDir(async (dir) => {
    const db = new Database(":memory:");
    migrate(db);
    const backupDir = join(dir, "backups");

    await assert.rejects(
      runBackup(db, backupDir, undefined, undefined, () => 0),
      /Skipped/,
    );
    assert.deepEqual(await readdir(backupDir), []);
  });
});

// Old copies are still deleted when today's is skipped; otherwise a full
// disk would stay full.
test("runBackup prunes expired copies even when it skips today's", async () => {
  await withTempDir(async (dir) => {
    const db = new Database(":memory:");
    migrate(db);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await writeFile(join(dir, "genug-2020-01-01.db"), "old");
    await utimes(join(dir, "genug-2020-01-01.db"), old, old);

    await assert.rejects(
      runBackup(db, dir, undefined, undefined, () => 0),
      /Skipped/,
    );
    assert.deepEqual(await readdir(dir), []);
  });
});

test("runBackup writes a queryable backup file, creating the directory if needed", async () => {
  await withTempDir(async (dir) => {
    const db = new Database(":memory:");
    migrate(db);
    insertEvent(db, {
      event: "page_view",
      visitorId: "v1",
      sessionId: "s1",
      ts: "2026-01-01T00:00:00.000Z",
      url: "https://example.com/",
      props: {},
    });

    const backupDir = join(dir, "nested", "backups");
    await runBackup(db, backupDir);

    const files = await readdir(backupDir);
    assert.equal(files.length, 1);

    const backupDb = new Database(join(backupDir, files[0]!), {
      readonly: true,
    });
    const row = backupDb
      .prepare("SELECT visitor_id FROM events WHERE visitor_id = ?")
      .get("v1");
    assert.ok(row);
    backupDb.close();
  });
});

test("pruneOldBackups deletes only backup files older than 7 days", async () => {
  await withTempDir(async (dir) => {
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const recent = new Date(now - 1 * 24 * 60 * 60 * 1000);

    await writeFile(join(dir, "genug-2020-01-01.db"), "old");
    await utimes(join(dir, "genug-2020-01-01.db"), old, old);

    await writeFile(join(dir, "genug-2026-09-07.db"), "recent");
    await utimes(join(dir, "genug-2026-09-07.db"), recent, recent);

    // Not a backup file — must be left alone regardless of age.
    await writeFile(join(dir, "unrelated.txt"), "old");
    await utimes(join(dir, "unrelated.txt"), old, old);

    await pruneOldBackups(dir);

    const remaining = (await readdir(dir)).sort();
    assert.deepEqual(remaining, ["genug-2026-09-07.db", "unrelated.txt"]);
  });
});

// The event files are backed up too, or a restore would bring back the
// events without their definitions.
test("runBackup copies the event schema directory beside the database", async () => {
  await withTempDir(async (dir) => {
    const db = new Database(":memory:");
    migrate(db);

    const eventsDir = join(dir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, "order_placed.json"),
      '{"_description":"x"}',
    );

    const backupDir = join(dir, "backups");
    await runBackup(db, backupDir, eventsDir);

    const entries = (await readdir(backupDir)).sort();
    assert.equal(entries.length, 2, entries.join(", "));
    const copied = entries.find((entry) => entry.endsWith("-events"));
    assert.ok(
      copied,
      `expected a dated events directory in ${entries.join(", ")}`,
    );
    assert.equal(
      await readFile(join(backupDir, copied, "order_placed.json"), "utf8"),
      '{"_description":"x"}',
    );
  });
});

// Both folders at once. runBackup takes them as two optional parameters
// of the same type, so swapping them wouldn't be noticed by tests that
// pass only one. The history log matters most, since nothing else can
// re-create it.
test("runBackup copies the events and context directories to their own names", async () => {
  await withTempDir(async (dir) => {
    const db = new Database(":memory:");
    migrate(db);

    const eventsDir = join(dir, "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, "order_placed.json"),
      '{"_description":"x"}',
    );

    const contextDir = join(dir, "context");
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      join(contextDir, "history.json"),
      '[{"from":"2026-06-15","note":"Launch."}]',
    );

    const backupDir = join(dir, "backups");
    await runBackup(db, backupDir, eventsDir, contextDir);

    const entries = await readdir(backupDir);
    const events = entries.find((entry) => entry.endsWith("-events"));
    const context = entries.find((entry) => entry.endsWith("-context"));
    assert.ok(events, `no dated events directory in ${entries.join(", ")}`);
    assert.ok(context, `no dated context directory in ${entries.join(", ")}`);

    assert.match(
      await readFile(join(backupDir, events, "order_placed.json"), "utf8"),
      /_description/,
    );
    assert.match(
      await readFile(join(backupDir, context, "history.json"), "utf8"),
      /Launch\./,
    );
  });
});

test("runBackup still backs up the database when there is no events directory", async () => {
  await withTempDir(async (dir) => {
    const db = new Database(":memory:");
    migrate(db);

    const backupDir = join(dir, "backups");
    await runBackup(db, backupDir, join(dir, "does-not-exist"));

    const entries = await readdir(backupDir);
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith("-events")),
      [],
    );
    assert.equal(entries.length, 1);
  });
});

// Old backups include folders (the event files), which must be deleted
// too.
test("pruneOldBackups deletes an expired events directory, not just files", async () => {
  await withTempDir(async (dir) => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    const expired = join(dir, "genug-2020-01-01-events");
    await mkdir(expired, { recursive: true });
    await writeFile(join(expired, "order_placed.json"), "{}");
    await utimes(expired, old, old);

    await pruneOldBackups(dir);

    assert.deepEqual(await readdir(dir), []);
  });
});

test("parseLocalBackupsEnabled defaults to true when unset", () => {
  assert.equal(parseLocalBackupsEnabled(undefined), true);
});

test("parseLocalBackupsEnabled parses explicit true/false", () => {
  assert.equal(parseLocalBackupsEnabled("true"), true);
  assert.equal(parseLocalBackupsEnabled("false"), false);
});

test("parseLocalBackupsEnabled throws for anything else", () => {
  assert.throws(() => parseLocalBackupsEnabled("yes"));
  assert.throws(() => parseLocalBackupsEnabled("1"));
});
