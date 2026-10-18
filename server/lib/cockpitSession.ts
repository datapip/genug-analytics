import { createHmac, scryptSync } from "node:crypto";
import { timingSafeStringEqual } from "./auth.js";

// The cockpit's sign-in session: a signed expiry time and nothing else.
// There is one password and one owner, so the token doesn't need to say
// who is signed in, only until when. The signature stops anyone from
// changing it.
//
// Sessions aren't stored on the server. That would need a database table
// or an in-memory list lost at every restart, and the 12-hour expiry
// already does the job.

export const COCKPIT_SESSION_COOKIE = "genug_cockpit_session";

// Long enough for an afternoon of work, short enough that a laptop left
// open somewhere doesn't stay signed in for days. There is no "remember
// me", since this is an admin page.
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// A fixed label added to the salt, so this key can never equal a key
// derived from the same password for another purpose. The salt itself is
// random per installation (lib/cockpitSessionSalt.ts).
const KEY_CONTEXT = "genug-cockpit-session";
const KEY_BYTES = 32;

// Derives the signing key from COCKPIT_PASSWORD with scrypt.
//
// Using the password means changing it signs out every session, and there
// is no second secret to configure. But with a fast hash, anyone who got
// hold of one cookie could guess passwords against it on their own
// computer, billions per second, without this server ever seeing it.
// scrypt is deliberately slow and memory-hungry (~100ms and 16 MB per
// guess), which makes that impractical.
//
// Called once at startup, so the slowness costs nobody any waiting.
export function deriveSessionKey(password: string, salt: Buffer): Buffer {
  return scryptSync(
    password,
    Buffer.concat([Buffer.from(KEY_CONTEXT), salt]),
    KEY_BYTES,
  );
}

export function issueSessionToken(
  key: Buffer,
  now: number = Date.now(),
): string {
  const expiresAt = now + SESSION_MAX_AGE_MS;
  return `${expiresAt}.${sign(String(expiresAt), key)}`;
}

export interface SessionCheck {
  // When the token was issued, worked out from its expiry. Lets the
  // caller reject tokens issued before a sign-out without storing them.
  issuedAt: number;
}

// Returns the checked token, or undefined for anything invalid. It never
// throws or says why: the caller answers 401 either way.
export function verifySessionToken(
  token: string | undefined,
  key: Buffer,
  now: number = Date.now(),
): SessionCheck | undefined {
  if (!token) return undefined;

  const separator = token.indexOf(".");
  if (separator === -1) return undefined;
  const claimedExpiry = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  // Check the signature over the expiry text exactly as received, not
  // over a number parsed from it: "0123" and "123" are the same number
  // but different text.
  if (!timingSafeStringEqual(signature, sign(claimedExpiry, key))) {
    return undefined;
  }

  // The signature is valid, so the expiry can be trusted now.
  const expiresAt = Number(claimedExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined;

  return { issuedAt: expiresAt - SESSION_MAX_AGE_MS };
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}
