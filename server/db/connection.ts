import Database from "better-sqlite3";

// Explains the most common deployment error. better-sqlite3 only says
// "SQLITE_CANTOPEN: unable to open database file". The container runs as
// a normal user (see the Dockerfile), so the cause is almost always who
// owns the folder: a folder mounted from the host keeps the host's
// owner.
//
// The folder must be writable, not just the file: SQLite creates -wal and
// -shm files next to the database, and the backups go in a backups/
// folder there.
function open(path: string): Database.Database {
  try {
    return new Database(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // process.getuid is Unix-only; it's absent on Windows.
    const uid = process.getuid?.();
    throw new Error(
      `Could not open the database at ${path}: ${detail}\n` +
        `The directory containing it must exist and be writable by the user this ` +
        `process runs as${uid === undefined ? "" : ` (uid ${uid})`}. ` +
        `In Docker, a bind-mounted host directory keeps the host's ownership — ` +
        `fix it with: chown -R 1000:1000 /your/data/dir`,
      { cause: error },
    );
  }
}

// Opens a connection with the settings below, without updating the
// tables. The server calls openDatabase in db/index.ts, which does both.
export function openConnection(path: string): Database.Database {
  const db = open(path);

  // One writer (/events) and many readers (MCP queries). WAL mode lets
  // them work without blocking each other.
  db.pragma("journal_mode = WAL");

  // SQLite's default, FULL, waits for the disk on every commit: about
  // 1.4 ms per event, so at most ~700 events per second, and
  // better-sqlite3 blocks Node while it waits. NORMAL leaves the write to
  // the operating system and reaches ~9,000 per second.
  //
  // This is safe with WAL mode: the log is checksummed, so after a crash
  // SQLite stops at the first damaged record. A power cut can lose the
  // last fraction of a second of events but can't corrupt the database.
  // (NORMAL's bad reputation comes from the older non-WAL mode.) A crash
  // of only this process loses nothing.
  //
  // Losing a few page views in a power cut is an acceptable price; see
  // docs/decisions.md.
  db.pragma("synchronous = NORMAL");

  // Normally a DELETE in SQLite leaves the row's bytes in the file until
  // the space is reused, so anyone with the file could still read them.
  // secure_delete overwrites them with zeros, so delete_visitor_data
  // really erases. The WAL still has the old data until a checkpoint,
  // which is why deleteVisitorData in lib/retention.ts runs one.
  db.pragma("secure_delete = ON");
  return db;
}
