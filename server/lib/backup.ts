import type Database from "better-sqlite3";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Fixed, not configurable — this is a "keep a week of safety nets"
// default, distinct from RETENTION_DAYS (which governs event data, not
// backup files, and is meant to be tuned per deployment).
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BACKUP_FILE_PREFIX = "genug-";

function backupFileName(now: Date): string {
  return `${BACKUP_FILE_PREFIX}${now.toISOString().slice(0, 10)}.db`;
}

// The event schema files get the same date stamp as the database taken
// beside them, so a restore can pair the two.
function backupEventsDirName(now: Date): string {
  return `${BACKUP_FILE_PREFIX}${now.toISOString().slice(0, 10)}-events`;
}

function backupContextDirName(now: Date): string {
  return `${BACKUP_FILE_PREFIX}${now.toISOString().slice(0, 10)}-context`;
}

// Defaults to enabled (unset means "yes") — most deployments want this
// on, and there's no directory to configure (index.ts derives it from
// DB_PATH). Fails fast on a typo'd value rather than silently treating
// it as either on or off, same reasoning as parseRetentionDays.
export function parseLocalBackupsEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`LOCAL_BACKUPS must be "true" or "false", got: ${value}`);
}

// db.backup() uses SQLite's own Online Backup API (built into
// better-sqlite3, no extra dependency) — safe to run against a live,
// actively-written database, unlike a plain file copy of a WAL-mode
// database (see README's "Data lifecycle" section for why that matters).
export async function runBackup(
  db: Database.Database,
  dir: string,
  eventsDir?: string,
  contextDir?: string,
): Promise<void> {
  const now = new Date();
  await mkdir(dir, { recursive: true });
  await db.backup(join(dir, backupFileName(now)));
  // The deployment's own event schemas, if it has any. They are tiny,
  // this job already runs daily, and without them a volume loss brings
  // the deployment back with a database full of events nothing can
  // describe any more — the data survives and the vocabulary doesn't.
  if (eventsDir !== undefined && existsSync(eventsDir)) {
    await cp(eventsDir, join(dir, backupEventsDirName(now)), {
      recursive: true,
    });
  }
  // The context directory joined this list when the history log landed.
  // ground-rules.md alone did not need it — an absent one is re-seeded
  // from the image on the next start, so losing it costs an edit. The
  // history log is different in kind: nothing can re-create an owner's
  // record of what happened to their site.
  if (contextDir !== undefined && existsSync(contextDir)) {
    await cp(contextDir, join(dir, backupContextDirName(now)), {
      recursive: true,
    });
  }
  await pruneOldBackups(dir);
}

export async function pruneOldBackups(dir: string): Promise<void> {
  const cutoff = Date.now() - BACKUP_MAX_AGE_MS;
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (!entry.startsWith(BACKUP_FILE_PREFIX)) continue;
    const path = join(dir, entry);
    const { mtimeMs } = await stat(path);
    if (mtimeMs < cutoff) {
      // Recursive: an expired entry may be a dated events *directory*,
      // not just a .db file, and unlink cannot remove one.
      await rm(path, { recursive: true, force: true });
    }
  }
}
