import type { Request, Response, NextFunction } from "express";
import { logInfo } from "./logger.js";
import { limiterKey } from "./ip.js";

const WINDOW_MS = 60 * 1000; // 1 minute
// Events allowed per address per minute. Generous on purpose: it is
// meant to stop a runaway loop or a simple scraper, which send thousands
// a minute and hit this limit as quickly as a lower one. A low limit
// would lose real data, because one address can be hundreds of people (an
// office, a school, a mobile carrier), and sendBeacon never sees the
// refusal. The log line below shows when real traffic hits the limit.
const EVENTS_MAX_PER_WINDOW = 600;
// MCP calls allowed per address per minute, for requests with the right
// key. A tenth of the events limit: one address on /mcp is one agent,
// which makes a handful of calls per question, and a call can be much
// more expensive than storing an event. A public key (READ_ONLY, see
// env.ts) invites loops. Only requests with the right key count here
// (lib/mcpAuth.ts), because hosted agents share addresses with the
// vendor's other customers.
export const MCP_MAX_PER_WINDOW = 60;
// All other /mcp requests per address (no key or a wrong one). This
// limits guessing the key, so it is low: a real client sends the key on
// every call.
export const MCP_KEYLESS_MAX_PER_WINDOW = 10;
// Cockpit requests per address per minute. One page load is about six
// requests, so this allows twenty reloads a minute. It protects the
// public demo (READ_ONLY, with a public password): the data route
// blocks Node while it runs, so someone reloading constantly would delay
// event collection.
export const COCKPIT_MAX_PER_WINDOW = 120;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

interface WindowState {
  count: number;
  windowStart: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  // Seconds until this key's minute is over, so a refusal can say how
  // long to wait. Zero when the request was allowed.
  retryAfterSeconds: number;
  // True only for the first request over the limit in a minute, so the
  // caller logs once per minute per address rather than once per refused
  // request.
  firstRefusal: boolean;
}

// `hits` and `now` are parameters so tests can pass their own map and
// time.
export function checkRateLimit(
  hits: Map<string, WindowState>,
  ip: string,
  now: number,
  maxPerWindow: number,
): RateLimitDecision {
  const entry = hits.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return { allowed: true, firstRefusal: false, retryAfterSeconds: 0 };
  }

  entry.count++;
  const allowed = entry.count <= maxPerWindow;
  return {
    allowed,
    firstRefusal: entry.count === maxPerWindow + 1,
    retryAfterSeconds: allowed
      ? 0
      : secondsUntil(entry.windowStart + WINDOW_MS, now),
  };
}

// At least 1, because Retry-After: 0 means "try again now".
function secondsUntil(deadline: number, now: number): number {
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}

// One limiter per route, each with its own map, so traffic on one route
// doesn't use up another's limit. Kept in memory, which is fine because
// this is always a single process (see "Repo structure" in
// docs/decisions.md). It won't stop a determined attack from many
// addresses (that needs a CDN or firewall in front); it stops runaway
// loops and simple scrapers.
export function createRequestLimiter(
  maxPerWindow: number,
  route: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, WindowState>();
  sweepPeriodically(hits, WINDOW_MS);

  return (req, res, next) => {
    // Not req.ip: an IPv6 client has a whole block of addresses and
    // would get a limit for each one. See lib/ip.ts.
    const ip = limiterKey(req.ip ?? "");
    const { allowed, firstRefusal, retryAfterSeconds } = checkRateLimit(
      hits,
      ip,
      Date.now(),
      maxPerWindow,
    );
    if (!allowed) {
      // Nobody sees a refusal on /events: sendBeacon ignores the
      // response, and nothing is stored. This log line, once per minute,
      // is the only sign that real traffic is being lost.
      if (firstRefusal) {
        logInfo("rate limit reached", {
          route,
          ip,
          limit: maxPerWindow,
          windowSeconds: WINDOW_MS / 1000,
        });
      }
      // A message and Retry-After, not a bare 429: an agent that isn't
      // told how long to wait may report an outage to its user.
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "rate limit reached",
        retryAfterSeconds,
      });
      return;
    }
    next();
  };
}

export const rateLimitEvents = createRequestLimiter(
  EVENTS_MAX_PER_WINDOW,
  "/events",
);

export const rateLimitCockpit = createRequestLimiter(
  COCKPIT_MAX_PER_WINDOW,
  "/cockpit",
);

// Removes old entries; otherwise each map would keep one entry for every
// address ever seen. Runs on a timer, so it also cleans up during quiet
// times. unref() lets the process (and `node --test`) exit while the
// timer waits.
function sweepPeriodically(
  entries: Map<string, WindowState>,
  windowMs: number,
): void {
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, entry] of entries) {
      if (entry.windowStart < cutoff) entries.delete(ip);
    }
  }, SWEEP_INTERVAL_MS).unref();
}

export interface FailedAttemptLimiter {
  isBlocked(ip: string, now?: number): boolean;
  recordFailure(ip: string, now?: number): void;
  // How long the current block still lasts, for Retry-After. Zero when
  // the key isn't blocked.
  retryAfterSeconds(ip: string, now?: number): number;
}

// Counts failed cockpit sign-ins, not requests. A successful sign-in
// doesn't count.
//
// A blocked address is refused without checking its password, so even
// the right password is refused until the block ends. Otherwise it could
// keep guessing at full speed. See "Brute-force protection" in
// docs/decisions.md. Kept in memory, like the limiter above.
export function createFailedAttemptLimiter(
  maxFailures: number,
  windowMs: number,
): FailedAttemptLimiter {
  const failures = new Map<string, WindowState>();
  sweepPeriodically(failures, windowMs);

  // Every method shortens the address first, as the request limiter
  // does; otherwise an IPv6 attacker would get a separate limit for
  // every address in their block.
  return {
    isBlocked(ip: string, now = Date.now()): boolean {
      const entry = failures.get(limiterKey(ip));
      if (!entry || now - entry.windowStart > windowMs) return false;
      return entry.count >= maxFailures;
    },

    recordFailure(ip: string, now = Date.now()): void {
      const key = limiterKey(ip);
      const entry = failures.get(key);
      if (!entry || now - entry.windowStart > windowMs) {
        failures.set(key, { count: 1, windowStart: now });
        return;
      }
      entry.count++;
    },

    retryAfterSeconds(ip: string, now = Date.now()): number {
      const entry = failures.get(limiterKey(ip));
      if (!entry || now - entry.windowStart > windowMs) return 0;
      if (entry.count < maxFailures) return 0;
      return secondsUntil(entry.windowStart + windowMs, now);
    },
  };
}
