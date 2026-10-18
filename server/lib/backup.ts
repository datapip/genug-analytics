import type Database from "better-sqlite3";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { freeBytes, MIN_FREE_BYTES } from "./diskSpace.js";

// How many days of backups to keep. Fixed on purpose; RETENTION_DAYS is
// the setting for how long event data is kept.
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUP_FILE_PREFIX = "genug-";

function backupFileName(now: Date): string {
  return `${BACKUP_FILE_PREFIX}${now.toISOString().slice(0, 10)}.db`;
}

// The event files get the same date as the database copy made with
// them, so a restore can match the two.
function backupEventsDirName(now: Date): string {
  return `${BACKUP_FILE_PREFIX}${now.toISOString().slice(0, 10)}-events`;
}

function backupContextDirName(now: Date): string {
  return `${BACKUP_FILE_PREFIX}${now.toISOString().slice(0, 10)}-context`;
}

// On unless set to false. The backup folder comes from DB_PATH, so there
// is nothing else to configure. A value that is neither true nor false
// stops the server at startup instead of being guessed.
export function parseLocalBackupsEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`LOCAL_BACKUPS must be "true" or "false", got: ${value}`);
}

// db.backup() uses SQLite's backup API, which is safe while the database
// is being written. Copying the file directly is not, in WAL mode (see
// "Data lifecycle" in the README).
export async function runBackup(
  db: Database.Database,
  dir: string,
  eventsDir?: string,
  contextDir?: string,
  // Replaced in tests, which can't fill a real disk.
  freeSpace: (directory: string) => number | undefined = freeBytes,
): Promise<void> {
  const now = new Date();
  await mkdir(dir, { recursive: true });
  // Delete old copies first, so their space counts in the check below.
  await pruneOldBackups(dir);
  // A copy is as big as the database; if it filled the disk, the live
  // database could no longer write. So skip it when space is below the
  // minimum in lib/diskSpace.ts. The caller logs the error; existing
  // copies are kept.
  const size = db.memory ? 0 : (await stat(db.name)).size;
  const free = freeSpace(dir);
  if (free !== undefined && free - size < MIN_FREE_BYTES) {
    throw new Error(
      `Skipped: a ${size}-byte copy would leave less than ${MIN_FREE_BYTES} bytes free in ${dir} (${free} free).`,
    );
  }
  await db.backup(join(dir, backupFileName(now)));
  // The event files too. Without them, restoring after losing the volume
  // would bring back the events but not their definitions.
  if (eventsDir !== undefined && existsSync(eventsDir)) {
    await cp(eventsDir, join(dir, backupEventsDirName(now)), {
      recursive: true,
    });
  }
  // The context directory, mainly for history.json: nothing could
  // re-create the owner's record of what happened to their site.
  if (contextDir !== undefined && existsSync(contextDir)) {
    await cp(contextDir, join(dir, backupContextDirName(now)), {
      recursive: true,
    });
  }
}

export async function pruneOldBackups(dir: string): Promise<void> {
  const cutoff = Date.now() - BACKUP_MAX_AGE_MS;
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (!entry.startsWith(BACKUP_FILE_PREFIX)) continue;
    const path = join(dir, entry);
    const { mtimeMs } = await stat(path);
    if (mtimeMs < cutoff) {
      // Recursive, because an old backup may be a folder (the event
      // files), not just a .db file.
      await rm(path, { recursive: true, force: true });
    }
  }
}
