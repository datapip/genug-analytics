import {
  Router,
  json,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { timingSafeStringEqual } from "./auth.js";
import { parseCookies } from "./cookies.js";
import {
  COCKPIT_SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  deriveSessionKey,
  issueSessionToken,
  verifySessionToken,
} from "./cockpitSession.js";
import {
  createFailedAttemptLimiter,
  type FailedAttemptLimiter,
} from "./rateLimit.js";

// Stricter than the /events limit, and counting failed attempts only: a
// person mistyping the password a few times is fine, a script trying a
// list of passwords is not.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// One shared limit for every place the cockpit password is typed: the
// sign-in here and the two danger-zone confirmations in
// routes/cockpit/danger.ts. Otherwise someone with a stolen session
// cookie could guess the password at full speed in a confirmation box.
// Ten wrong guesses anywhere block all of them.
export const cockpitPasswordLimiter: FailedAttemptLimiter =
  createFailedAttemptLimiter(MAX_FAILURES, FAILURE_WINDOW_MS);

// The response for a blocked address, wherever it typed the password.
export function refuseLockedOut(
  limiter: FailedAttemptLimiter,
  ip: string,
  res: Response,
): boolean {
  if (!limiter.isBlocked(ip)) return false;
  const retryAfterSeconds = limiter.retryAfterSeconds(ip);
  res.set("Retry-After", String(retryAfterSeconds));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  res.status(429).json({
    ok: false,
    error: `Too many failed attempts. Try again in ${minutes} ${
      minutes === 1 ? "minute" : "minutes"
    }.`,
  });
  return true;
}

// Where a browser without a session is sent. A fixed value, never taken
// from the request: a sign-in page that redirects wherever a link says
// can send the owner to a fake copy of the page that collects the
// password.
export const LOGIN_PATH = "/cockpit/login.html";

// The only paths under /cockpit served without a session. Exact strings
// compared with req.path, no prefixes or patterns, because a "starts
// with" rule is easy to get around with tricks like "../". req.path is
// not percent-decoded (express.static decodes), so an encoded spelling
// like /cockpit%2Ecss doesn't match and gets a 401, which is the safe
// way to fail.
//
// These are the sign-in page and the files it needs: markup, the
// stylesheet, a small theme switch and an icon. They are public in the
// image anyway and contain no data. The cockpit's index.html is
// deliberately not on the list.
const PUBLIC_GETS = new Set([
  "/login.html",
  "/login.js",
  "/cockpit.css",
  "/theme.js",
  "/favicon.svg",
]);

const SESSION_ROUTE = "/session";

// The session cookie, sent by the browser to /cockpit only. Its path
// keeps the session away from /events, which is public and the busiest
// route.
//
// SameSite=Lax rather than Strict: Lax already stops the cookie on
// cross-site POST/PUT/DELETE, which covers every write. Strict would
// also drop it when following a normal link, so opening the cockpit from
// a link in a chat would show the sign-in page although a session exists.
//
// Always Secure, like the visitor cookie in routes/events.ts, rather than
// depending on req.secure (which depends on TRUST_PROXY). Browsers treat
// http://localhost as secure, so a local run works. A LAN address over
// plain http doesn't, and the sign-in page says so instead of it looking
// like a wrong password.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/cockpit",
} as const;

// The time of the last sign-out: tokens issued before it are refused. Kept
// in memory, so a restart resets it (like the failed-attempt limit).
//
// There is one password and one owner, so signing out signs out every
// browser. The usual reason to sign out is that a session might be
// somewhere it shouldn't be.
let sessionsIssuedBefore = 0;

// The per-address lockout can't stop someone with a stolen cookie, who
// can guess from many addresses. But they can't change the session. So
// this many wrong confirmations in a row, from anywhere, sign every
// browser out. Only a signed-in browser can reach the confirmation boxes,
// so a stranger can't use this against the owner. If the owner mistypes
// five times, they just sign in again.
const MAX_CONFIRMATION_FAILURES = 5;
let confirmationFailures = 0;

// Returns true when this failure signed every session out.
export function recordConfirmationFailure(): boolean {
  confirmationFailures++;
  if (confirmationFailures < MAX_CONFIRMATION_FAILURES) return false;
  confirmationFailures = 0;
  sessionsIssuedBefore = Date.now();
  return true;
}

export function clearConfirmationFailures(): void {
  confirmationFailures = 0;
}

export interface CockpitAuth {
  // Before the session check: signing in and signing out must work
  // without a valid session.
  router: Router;
  // Everything else under /cockpit.
  requireSession: (req: Request, res: Response, next: NextFunction) => void;
}

// `password` is required, so the cockpit can never be left open: it
// shows recent URLs and props, which can contain order ids and other
// business data. loadConfig (lib/config.ts) stops the server when
// COCKPIT_PASSWORD is unset, as for MCP_API_KEY.
export function createCockpitAuth(
  password: string,
  sessionSalt: Buffer,
  limiter: FailedAttemptLimiter = cockpitPasswordLimiter,
): CockpitAuth {
  const key = deriveSessionKey(password, sessionSalt);
  const router = Router();

  // 1 KB: apart from /events this is the only POST without a session,
  // and it only needs to carry a password.
  router.post(SESSION_ROUTE, json({ limit: "1kb" }), (req, res) => {
    const ip = req.ip ?? "unknown";
    if (refuseLockedOut(limiter, ip, res)) return;

    // The same header every cockpit write requires, in addition to
    // SameSite. Otherwise another site could submit a sign-in form in the
    // owner's browser.
    if (req.get("x-genug-cockpit") !== "1") {
      res.status(400).json({
        ok: false,
        error: "Sign-in must be requested from the cockpit login page.",
      });
      return;
    }

    const body: unknown = req.body;
    const supplied =
      typeof body === "object" && body !== null && "password" in body
        ? (body as { password: unknown }).password
        : undefined;

    // Every request here contains a guess, so every failure counts.
    if (
      typeof supplied !== "string" ||
      !timingSafeStringEqual(supplied, password)
    ) {
      limiter.recordFailure(ip);
      res.status(401).json({ ok: false, error: "That password is not right." });
      return;
    }

    res.cookie(COCKPIT_SESSION_COOKIE, issueSessionToken(key), {
      ...COOKIE_OPTIONS,
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({ ok: true });
  });

  // Works without a session, so an old tab can still sign out. But only a
  // valid session, sent from the cockpit itself, signs out every browser.
  // Otherwise anyone (a script, or a hidden form on another site) could
  // keep the owner signed out. Other requests only clear their own
  // cookie. Clearing must use the same options the cookie was set with,
  // or the browser keeps it and the owner wrongly thinks they signed out.
  //
  // `revoked` says whether every browser was signed out, so an old tab
  // isn't told it signed out everyone when it didn't.
  router.post("/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COCKPIT_SESSION_COOKIE];
    const session = verifySessionToken(token, key);
    const revoked =
      req.get("x-genug-cockpit") === "1" &&
      session !== undefined &&
      session.issuedAt >= sessionsIssuedBefore;
    if (revoked) sessionsIssuedBefore = Date.now();
    res.clearCookie(COCKPIT_SESSION_COOKIE, COOKIE_OPTIONS);
    res.json({ ok: true, revoked });
  });

  function requireSession(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      PUBLIC_GETS.has(req.path)
    ) {
      next();
      return;
    }

    const token = parseCookies(req.headers.cookie)[COCKPIT_SESSION_COOKIE];
    const session = verifySessionToken(token, key);
    if (session && session.issuedAt >= sessionsIssuedBefore) {
      next();
      return;
    }

    // Check Sec-Fetch-Dest, not Accept. Opening the address in the
    // browser sends "document" and should get the sign-in page;
    // cockpit.js's fetch() sends "empty" and needs a status code. Accept
    // doesn't work: fetch sends `*/*`, which matches text/html, so JSON
    // requests would get the sign-in page's HTML.
    //
    // Clients that send neither (curl, a monitor) get the 401.
    if (req.get("sec-fetch-dest") === "document") {
      res.redirect(LOGIN_PATH);
      return;
    }

    res.status(401).json({ ok: false, error: "Your session has expired." });
  }

  return { router, requireSession };
}

// Only for tests: the sign-out time above is shared by all
// createCockpitAuth calls, so one test's sign-out would otherwise
// invalidate the sessions of every later test.
export function resetSessionRevocationForTests(): void {
  sessionsIssuedBefore = 0;
  confirmationFailures = 0;
}
