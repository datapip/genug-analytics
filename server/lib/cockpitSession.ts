import { createHmac, scryptSync } from "node:crypto";
import { timingSafeStringEqual } from "./auth.js";

// The cockpit's session: a signed expiry, and nothing else. There is one
// password and one owner, so there is no identity to carry and no second
// session to tell this one apart from — a token that says when it stops
// being valid, signed so it cannot be edited, is the whole requirement.
//
// No session store. Storing sessions would mean either a table to
// migrate or a Map that empties on every redeploy, and neither buys
// anything a 12-hour expiry doesn't.

export const COCKPIT_SESSION_COOKIE = "genug_cockpit_session";

// Long enough to not interrupt an afternoon of looking at the numbers,
// short enough that a laptop left open somewhere is not a standing
// invitation. Deliberately not "remember me" — this is an admin surface.
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Domain separation, so the key can never collide with another use of
// the same password. Doubles as scrypt's salt: its real job is stopping
// one precomputed table from covering many targets, and with a single
// password on a single deployment a fixed string does that well enough.
const KEY_CONTEXT = "genug-cockpit-session";
const KEY_BYTES = 32;

// scrypt, not HMAC, and this is the whole reason the function exists.
//
// The key is derived from COCKPIT_PASSWORD on purpose: rotating the
// password then invalidates every live session for free, and there is no
// second secret to configure. But a token signed with a *fast* hash of a
// human-chosen password is an offline cracking oracle — anyone who ever
// sees one cookie can guess passwords against it on their own hardware,
// billions a second, where neither the failed-attempt lockout nor this
// server can see them. A stolen cookie would be worth the password
// itself rather than twelve hours. scrypt is deliberately slow and
// memory-hard, which takes that back: ~100ms and 16 MB per guess.
//
// Called once at startup, so the cost is paid on a path where nobody is
// waiting.
export function deriveSessionKey(password: string): Buffer {
  return scryptSync(password, KEY_CONTEXT, KEY_BYTES);
}

export function issueSessionToken(
  key: Buffer,
  now: number = Date.now(),
): string {
  const expiresAt = now + SESSION_MAX_AGE_MS;
  return `${expiresAt}.${sign(String(expiresAt), key)}`;
}

export interface SessionCheck {
  // When the token was issued, derived from its expiry. Lets the caller
  // reject tokens older than a logout without storing any of them.
  issuedAt: number;
}

// Returns the checked token, or undefined for anything that isn't one.
// Never throws and never says *why* — the only caller turns this into a
// 401 either way, and a token is not user input worth explaining.
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

  // Signed over the expiry exactly as it arrived, not over a number
  // parsed back out of it: "0123" and "123" are the same instant to
  // Number() and different strings to HMAC, and choosing which one is
  // authoritative is a question worth not having.
  if (!timingSafeStringEqual(signature, sign(claimedExpiry, key))) {
    return undefined;
  }

  // Only now is the expiry trustworthy enough to read.
  const expiresAt = Number(claimedExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined;

  return { issuedAt: expiresAt - SESSION_MAX_AGE_MS };
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("hex");
}
