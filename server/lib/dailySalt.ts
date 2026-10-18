import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { logError } from "./logger.js";
import { localDate } from "./timezone.js";

// The salt for the consentless visitor hash: random, one per day, and
// thrown away when the day ends. Because nobody keeps old salts, nobody
// can recompute a past day's visitor_id, even knowing an address and
// User-Agent.
//
// It is kept in a small file next to the database, so a restart during
// the day keeps the same salt. Kept only in memory, every deploy would
// count each visitor twice. The backup never copies this file, so no
// backup contains an old salt. The file is overwritten, so it only ever
// holds today's.
//
// The day is the site's day (TIMEZONE), the same day reports use, so a
// visitor is one visitor per reported day.
//
// The stored label has the time zone as well as the date. With the date
// alone, a file written under a zone further east could still match the
// local date here and be kept longer than a day. With the zone in the
// label, a file from any other zone is replaced at the next start.

const SALT_PATTERN = /^[a-f0-9]{64}$/;

export interface DailySalt {
  // Today's salt. Replaces the stored one first if it is from another
  // day.
  saltFor(now: Date): string;
}

function readStored(path: string): { day: string; salt: string } | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // Missing on the first start. Any other read error is handled the
    // same way: start a new salt.
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
    // Not our format, or not JSON. Replace it like an old file.
  }
  return undefined;
}

// Called at startup with the current time. A file from an earlier day
// (the server was stopped over midnight) is replaced right away, not at
// the first event, so an old salt never stays on disk after a start.
export function createDailySalt(
  path: string,
  timezone: string,
  now: Date = new Date(),
): DailySalt {
  let current = readStored(path);

  function rotate(day: string): { day: string; salt: string } {
    const next = { day, salt: randomBytes(32).toString("hex") };
    // Write to a temporary file, then rename it over the old one (as in
    // lib/atomicWrite.ts), so a crash never leaves a half-written file, and the old salt is gone as soon as the
    // new one is in place. 0600, because with this salt today's hashes
    // can be traced back to addresses.
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      // Collection must not stop over this, but the old salt must not
      // stay on disk either. The likely cause is a full disk, where
      // deleting still works. Without the file, visitors are only
      // counted twice if the server restarts today.
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
      const day = `${timezone} ${localDate(at, timezone)}`;
      if (current?.day !== day) current = rotate(day);
      return current.salt;
    },
  };
  salts.saltFor(now);
  return salts;
}

// Replaces the salt at midnight even when no event arrives, so
// yesterday's salt doesn't stay on disk until the day's first visitor.
// unref() lets the process (or a test run) exit while the timer waits.
export function startRotation(
  salts: DailySalt,
  everyMs = 60_000,
): NodeJS.Timeout {
  return setInterval(() => salts.saltFor(new Date()), everyMs).unref();
}
