import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomicWrite.js";
import { logError, logInfo } from "./logger.js";

// The scrypt salt for the cockpit's session key, random per installation.
// With a salt shared by every installation, the same password would give
// the same key everywhere, and one table of precomputed guesses would
// work against every cockpit. With its own salt, each installation has to
// be attacked separately.
//
// A salt only needs to be unique, not secret, but keeping it private also
// stops a stolen cookie from being guessed against offline. It is stored
// next to the database instead of generated at each start, because a new
// salt means a new key, and a new key signs every browser out. Losing the
// file costs only that, which is why the backup doesn't copy it. The file
// is 0600 since nothing else needs to read it.

export const SESSION_SALT_FILE = "cockpit-session-salt";

const SALT_BYTES = 16;
const SALT_PATTERN = /^[a-f0-9]{32}$/;

export function loadSessionSalt(path: string): Buffer {
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (SALT_PATTERN.test(stored)) return Buffer.from(stored, "hex");
  } catch {
    // Missing on the first start. Any other read error is treated the
    // same way.
  }

  const salt = randomBytes(SALT_BYTES);
  try {
    writeFileAtomic(path, salt.toString("hex") + "\n", 0o600);
    logInfo(`Created a new cockpit session salt at ${path}`);
  } catch (error) {
    // The cockpit still works with a salt that couldn't be saved; everyone
    // is just signed out at the next restart. Collection doesn't use it.
    logError(
      `Could not store the cockpit session salt at ${path}; cockpit sign-ins will not survive a restart`,
      error,
    );
  }
  return salt;
}
