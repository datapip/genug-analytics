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

// Tighter than the /events limiter, and counted per failed attempt
// rather than per request: a person typing the password wrong a few
// times is fine, a script working through a wordlist is not.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// Where a browser with no session is sent, as a constant. Never built
// from anything on the request: a login page that redirects onward to an
// address someone else chose is how a password ends up typed into
// somebody's copy of this page.
export const LOGIN_PATH = "/cockpit/login.html";

// The only paths this server answers under /cockpit without a session.
// Exact strings, matched against req.path — no prefixes, no patterns,
// because every "starts with" here is one path-traversal trick away from
// being a hole. Express does not percent-decode req.path while
// express.static does, so an encoded spelling like /cockpit%2Ecss simply
// misses the set and gets a 401: this fails closed, which is the right
// direction to fail.
//
// These files are the login page and what it needs to look like a page.
// They are markup, stylesheet, a ten-line theme switch and an icon
// shipped in a public image — there is no deployment's data in any of
// them. The cockpit's own index.html is deliberately *not* here, so
// "the shell is public" never becomes something a later change quietly
// relies on.
const PUBLIC_GETS = new Set([
  "/login.html",
  "/login.js",
  "/cockpit.css",
  "/theme.js",
  "/favicon.svg",
]);

const SESSION_ROUTE = "/session";

// A cookie the browser sends back to /cockpit and nowhere else. Path
// keeps the owner's session off /events, which is public, CORS-enabled
// and by far the busiest thing here.
//
// SameSite=Lax rather than Strict: Lax already withholds the cookie from
// every cross-site POST/PUT/DELETE, which is every write this router
// has, while Strict would additionally drop it on an ordinary link —
// opening the cockpit from a bookmark in a chat window would land on the
// login page with a live session sitting unused in the browser.
//
// Secure unconditionally, matching the visitor cookie in routes/events.ts
// rather than reading req.secure, which is only as true as TRUST_PROXY
// says it is and defaults to not trusting anything. Browsers treat
// http://localhost as a secure context, so a local run still works; a
// LAN address over plain http does not, and the login page says so
// rather than leaving it to read as a wrong password.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/cockpit",
} as const;

// Cleared on logout. Module-level, per process, and reset by a restart —
// the same shape and the same caveat as the failed-attempt limiter next
// door. It makes the button mean what it says for as long as the server
// is up, without a session store to migrate and empty on every redeploy.
//
// One password means one owner, so this signs out every browser at once.
// That is the honest behaviour for a tool with a single credential: the
// reason to press it is that a copy is somewhere it should not be.
let sessionsIssuedBefore = 0;

export interface CockpitAuth {
  // Mounted before the gate: the two routes a browser reaches without a
  // session yet, or on the way out.
  router: Router;
  // Everything else under /cockpit.
  requireSession: (req: Request, res: Response, next: NextFunction) => void;
}

// `password` is required rather than optional, so there is no way to end
// up with an open cockpit: it serves recent event URLs and raw props —
// where order ids and other business data live — at an entirely
// predictable hostname. server/index.ts fails fast at startup when
// COCKPIT_PASSWORD is unset, the same as MCP_API_KEY.
export function createCockpitAuth(
  password: string,
  limiter: FailedAttemptLimiter = createFailedAttemptLimiter(
    MAX_FAILURES,
    FAILURE_WINDOW_MS,
  ),
): CockpitAuth {
  const key = deriveSessionKey(password);
  const router = Router();

  // 1 KB. This is the only unauthenticated POST this server has outside
  // /events, and nothing legitimate sends more than a password.
  router.post(SESSION_ROUTE, json({ limit: "1kb" }), (req, res) => {
    const ip = req.ip ?? "unknown";
    if (limiter.isBlocked(ip)) {
      const retryAfterSeconds = limiter.retryAfterSeconds(ip);
      res.set("Retry-After", String(retryAfterSeconds));
      const minutes = Math.ceil(retryAfterSeconds / 60);
      res.status(429).json({
        ok: false,
        error: `Too many failed attempts. Try again in ${minutes} ${
          minutes === 1 ? "minute" : "minutes"
        }.`,
      });
      return;
    }

    // The same header every other write on this router requires. Belt
    // and braces beside SameSite: a login a stranger's page can trigger
    // is not an account takeover here, but it can log the owner into a
    // session of someone else's choosing, and refusing it costs a line.
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

    // Every request here carries a guess, unlike the Basic Auth
    // handshake this replaced — where a browser's first, credential-less
    // request was not an attempt at anything and counting it spent the
    // budget on nobody's guesses. So each failure counts, no exception.
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

  // Reachable without a session, so a stale tab can still sign out. But
  // only a live session sent from the cockpit itself moves the watermark
  // that signs out every browser: it is global, and when anyone could
  // move it, a curl loop — or a hidden form on any page — kept the owner
  // out of the cockpit for as long as it ran. Anyone else just has their
  // own cookie cleared. Clearing has to repeat the options the cookie was
  // set with — a clearCookie that disagrees about path or sameSite
  // silently clears nothing, and the owner is left believing they logged
  // out.
  //
  // `revoked` says which of the two happened. The reason to press the
  // button is often that a copy leaked, so a stale tab must not be told
  // it signed out every browser when it did not.
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

    // Sec-Fetch-Dest, not Accept. A browser typing the address in sends
    // "document" and wants the login page; cockpit.js's fetch() sends
    // "empty" and wants a status code it can act on. Accept looks like
    // the obvious test and is the wrong one — fetch sends `*/*`, which
    // matches text/html, so every JSON call would be answered with the
    // login page's HTML and surface as a parse error.
    //
    // Anything that sends neither header — curl, a monitor — gets the
    // 401, which is the safer default of the two.
    if (req.get("sec-fetch-dest") === "document") {
      res.redirect(LOGIN_PATH);
      return;
    }

    res.status(401).json({ ok: false, error: "Your session has expired." });
  }

  return { router, requireSession };
}

// Only for tests: the logout timestamp above outlives a single
// createCockpitAuth call, so one test's logout would otherwise invalidate
// the sessions every later test issues.
export function resetSessionRevocationForTests(): void {
  sessionsIssuedBefore = 0;
}
