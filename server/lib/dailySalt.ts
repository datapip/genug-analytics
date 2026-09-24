import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { logError } from "./logger.js";

// The consentless hash's salt: random, one per UTC day, and replaced —
// not kept — when the day ends. It used to be an HMAC of the date keyed
// by SALT_SECRET, so anyone holding that secret could rebuild the salt
// for any past day and, with a known address and User-Agent, that
// day's visitor_id. A random salt nobody keeps cannot be rebuilt.
//
// It sits in one small file beside the database so a restart during the
// day keeps it: in memory only, every deploy would split each visitor
// on the site into two. The backup copies the database, events and
// context directories, never this file, so no backup holds an old salt.
// The file is overwritten, never appended: it only ever holds today's.

const SALT_PATTERN = /^[a-f0-9]{64}$/;

export interface DailySalt {
  // Today's salt, rotated first when the stored one is from another day.
  saltFor(now: Date): string;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readStored(path: string): { day: string; salt: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Absent on a first start. Any other read failure lands here too,
    // and the answer is the same: start a new salt.
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "day" in parsed &&
      "salt" in parsed &&
      typeof parsed.day === "string" &&
      typeof parsed.salt === "string" &&
      SALT_PATTERN.test(parsed.salt)
    ) {
      return { day: parsed.day, salt: parsed.salt };
    }
  } catch {
    // Not ours, or not JSON. Replaced like a stale file.
  }
  return undefined;
}

// `now` is when the server starts. A file left from an earlier day — the
// server was stopped over midnight — is replaced right away rather than
// at the first event, so a stale salt never outlives the start.
export function createDailySalt(
  path: string,
  now: Date = new Date(),
): DailySalt {
  let current = readStored(path);

  function rotate(day: string): { day: string; salt: string } {
    const next = { day, salt: randomBytes(32).toString("hex") };
    // Write then rename, so a process crash mid-write never leaves a
    // half file, and the old salt is gone the moment the new one lands.
    // 0600: it is the one thing that turns today's hashes back into
    // addresses.
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      // Collection must not stop over this. But the old salt must not
      // outlive its day because the new one could not be written — a
      // full disk is the likely cause, and unlinking still works there.
      // Losing the file only splits visitors on the next restart.
      let removed = true;
      for (const leftover of [path, tmp]) {
        try {
          rmSync(leftover, { force: true });
        } catch {
          removed = false;
        }
      }
      logError(
        removed
          ? `Could not store the daily salt at ${path}; the old one was deleted`
          : `Could not store or delete the daily salt at ${path}; an earlier day's salt may still be there, delete it by hand`,
        error,
      );
    }
    return next;
  }

  const salts: DailySalt = {
    saltFor(at: Date): string {
      const day = utcDay(at);
      if (current?.day !== day) current = rotate(day);
      return current.salt;
    },
  };
  salts.saltFor(now);
  return salts;
}

// Rotates at midnight even when no event arrives, so yesterday's salt
// does not sit on disk until the first visitor of the day. unref: this
// timer alone must not keep the process, or a test run, alive.
export function startRotation(
  salts: DailySalt,
  everyMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => salts.saltFor(new Date()), everyMs).unref();
}
