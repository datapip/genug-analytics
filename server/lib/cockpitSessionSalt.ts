import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomicWrite.js";
import { logError, logInfo } from "./logger.js";

// The session key's scrypt salt, one per install. It used to be a fixed
// string, the same on every deployment, so one table of guesses
// precomputed against it covered every Genug cockpit at once, and the
// same password gave the same key everywhere. A random salt makes each
// install its own target: a stolen cookie has to be attacked from
// scratch.
//
// Not sensitive on its own — a salt only has to be unique — though one
// that stays private also keeps a stolen cookie from being guessed
// against offline. Kept beside the database rather than regenerated, because a new salt is a new key and
// a new key signs every browser out. Losing the file costs exactly that,
// once, which is why the backup does not bother copying it. 0600 anyway:
// nothing else needs to read it.

export const SESSION_SALT_FILE = "cockpit-session-salt";

const SALT_BYTES = 16;
const SALT_PATTERN = /^[a-f0-9]{32}$/;

export function loadSessionSalt(path: string): Buffer {
  try {
    const stored = readFileSync(path, "utf8").trim();
    if (SALT_PATTERN.test(stored)) return Buffer.from(stored, "hex");
  } catch {
    // Absent on a first start, and on the first start after this file
    // was introduced. Any other read failure gets the same answer.
  }

  const salt = randomBytes(SALT_BYTES);
  try {
    writeFileAtomic(path, salt.toString("hex") + "\n", 0o600);
    logInfo(`Created a new cockpit session salt at ${path}`);
  } catch (error) {
    // The cockpit still works with a salt it could not keep; it just
    // signs everyone out at the next restart, which is the safe way to
    // be wrong. Collection does not depend on it at all.
    logError(
      `Could not store the cockpit session salt at ${path}; cockpit sign-ins will not survive a restart`,
      error,
    );
  }
  return salt;
}
