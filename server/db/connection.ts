import Database from "better-sqlite3";

// `/data` is the container path this project's Docker/Coolify docs
// tell the operator to mount a persistent volume at (see README's
// "Configuration") — defaulting to a fixed path under it means most
// deployments never need to set DB_PATH at all. Still overridable
// (e.g. local dev/testing running outside Docker, see docs/manual-testing.md),
// since it's just a filesystem path, not a secret.
export const dbPath: string = process.env.DB_PATH ?? "/data/genug.db";

// Wrapped so the most likely deployment failure explains itself.
// better-sqlite3 throws a bare "SQLITE_CANTOPEN: unable to open database
// file", which says nothing about the actual cause — and since the
// container runs as an unprivileged user (see the Dockerfile), that
// cause is almost always directory ownership: a bind-mounted host
// directory keeps the host's ownership rather than the image's.
//
// Note this needs the *directory* to be writable, not just the file:
// WAL mode creates -wal/-shm files alongside the database, and
// LOCAL_BACKUPS writes a backups/ folder there.
function openDatabase(path: string): Database.Database {
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

export const db: Database.Database = openDatabase(dbPath);

// One writer (the events route), many readers (MCP tool queries) in a
// single process — WAL lets them proceed without blocking each other.
db.pragma("journal_mode = WAL");

// SQLite's default is FULL: an fsync per commit, so every single event
// waits for the platter before the request completes. Measured on the
// real schema that is ~1.4 ms per event and caps ingestion near 700
// events/sec — and because better-sqlite3 is synchronous, each of those
// milliseconds blocks the event loop. NORMAL hands the write to the OS
// instead and reaches ~9,000/sec on the same hardware.
//
// Safe here specifically because of the WAL above it: the write-ahead
// log is append-only and checksummed, so a recovering reader stops at
// the first record that doesn't verify. A hard kill (power loss, kernel
// panic) can cost the last fraction of a second of events; it cannot
// leave a torn or corrupt database. In the old rollback-journal mode
// NORMAL really could corrupt, which is where its reputation comes from
// — that hazard doesn't exist in WAL. A crash of this process alone
// loses nothing at all, since the OS buffer outlives it.
//
// The trade is deliberate: pageview counts are not a ledger, and paying
// an fsync per view forever to protect a handful of them from a power
// cut is the wrong side of it. See docs/decisions.md.
db.pragma("synchronous = NORMAL");
