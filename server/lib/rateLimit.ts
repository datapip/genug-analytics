import type { Request, Response, NextFunction } from "express";
import { logInfo } from "./logger.js";
import { limiterKey } from "./ip.js";

const WINDOW_MS = 60 * 1000; // 1 minute
// Events allowed per IP per window. Generous on purpose: this exists to
// stop a runaway loop or a basic scraper, both of which fire thousands a
// minute and trip it just as fast at this ceiling as at a tenth of it.
// A low ceiling costs real data instead, because one address is not one
// visitor — an office, a school or a mobile carrier's NAT puts hundreds
// of people behind a single one, and a refusal is invisible to
// sendBeacon, so the loss leaves no trace on either side. The log line
// below is what makes the number safe to tune: if legitimate traffic
// ever does trip it, you see that rather than guessing.
const EVENTS_MAX_PER_WINDOW = 600;
// MCP calls allowed per IP per window. A tenth of the events ceiling,
// because the two ends are not alike: one address on /events can be a
// whole office, while one address on /mcp is one agent, and an agent
// working through a question makes a handful of calls, not hundreds.
// The cost of a call is also not alike — a segment on an entry
// condition materialises every entry row of its period — and a key that
// is public (READ_ONLY, see env.ts) invites exactly the loop this
// bounds. Counted before the key is checked, so a flood is refused at
// the door whether or not it knows the key; guessing the key is the
// failed-attempt limiter's job below.
const MCP_MAX_PER_WINDOW = 60;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

interface WindowState {
  count: number;
  windowStart: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  // Seconds until this key's window rolls over, so a refusal can say
  // how long to wait instead of leaving the caller to guess. Zero when
  // the call was allowed.
  retryAfterSeconds: number;
  // True only on the one request that first crosses the limit in a given
  // window, so the caller can log once per window per IP instead of once
  // per refused request — a runaway loop would otherwise write log lines
  // exactly as fast as it writes requests, which is the scaling problem
  // the hourly bot counter exists to avoid.
  firstRefusal: boolean;
}

// Exported (and taking `hits` as a parameter, rather than reading a
// module-level map directly) purely so tests can hand it a throwaway
// map and an explicit `now`, the same reasoning as session.ts's
// resolveSessionId, without state leaking between test cases or
// needing to fake the system clock.
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

// At least 1: a Retry-After of 0 invites an immediate retry, which is
// the opposite of what a refusal is asking for.
function secondsUntil(deadline: number, now: number): number {
  return Math.max(1, Math.ceil((deadline - now) / 1000));
}

// One limiter per route, each with its own map, so a burst on one
// never spends the other's budget. In-memory, per-process — fine here
// since this is deliberately a single Express process with no
// horizontal scaling (see "Repo structure" in docs/decisions.md); a
// shared store (e.g. Redis) would only be needed if that changed. Not
// meant to stop a determined, distributed attacker — that's a job for a
// layer in front of this app (a CDN/WAF) — just to stop an accidental
// runaway loop or a basic scraper from writing unbounded rows, or
// running unbounded queries.
export function createRequestLimiter(
  maxPerWindow: number,
  route: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const hits = new Map<string, WindowState>();
  sweepPeriodically(hits, WINDOW_MS);

  return (req, res, next) => {
    // Not req.ip directly: an IPv6 client holds a whole block and would
    // otherwise get one budget per address in it. See lib/ip.ts.
    const ip = limiterKey(req.ip ?? "");
    const { allowed, firstRefusal, retryAfterSeconds } = checkRateLimit(
      hits,
      ip,
      Date.now(),
      maxPerWindow,
    );
    if (!allowed) {
      // A refusal on /events is invisible to the client: sendBeacon
      // surfaces no response, and a 429 never becomes a stored row, so
      // without this line a deployment losing real traffic to the
      // limiter has nothing anywhere to tell it. Logged once per
      // window, not per request.
      if (firstRefusal) {
        logInfo("rate limit reached", {
          route,
          ip,
          limit: maxPerWindow,
          windowSeconds: WINDOW_MS / 1000,
        });
      }
      // A body and a Retry-After, not a bare 429. /mcp answers two
      // different 429s — this one, and the key lockout in routes/mcp.ts
      // — and an agent that cannot tell "wait a minute" from "wait
      // fifteen" reports an outage to its human, which is this
      // project's worst failure: plausible, and wrong. The /events
      // client never reads either, which costs nothing.
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
export const rateLimitMcp = createRequestLimiter(MCP_MAX_PER_WINDOW, "/mcp");

// Without this, a map would grow by one entry per distinct IP ever seen
// and never shrink. Runs independently of the request path so it keeps
// sweeping even during a quiet period. unref()'d so this timer alone
// doesn't keep the process (or, importantly, `node --test`) alive —
// same reasoning importing this module for its tests shouldn't start a
// server.
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
  // How long the current block still has to run, for the caller's
  // Retry-After. Zero when the key is not blocked.
  retryAfterSeconds(ip: string, now?: number): number;
}

// Counts *failed* authentication attempts, not requests — an AI agent
// legitimately fires many /mcp calls in a burst, so a request limiter
// would throttle real work while barely slowing a guesser. A successful
// call consumes no budget at all.
//
// A blocked IP is refused without its credentials being checked, which
// necessarily locks out the real password until the window lapses.
// That is the point: checking a blocked IP's guess anyway would let it
// keep guessing at full speed. See "Brute-force protection" in
// docs/decisions.md for the tradeoff that accepts. Same in-memory, per-process
// caveat as the limiter above.
export function createFailedAttemptLimiter(
  maxFailures: number,
  windowMs: number,
): FailedAttemptLimiter {
  const failures = new Map<string, WindowState>();
  sweepPeriodically(failures, windowMs);

  // Every method narrows first, for the same reason the request
  // limiter does: without it an IPv6 attacker has as many guessing
  // budgets as they have addresses, which is all of them.
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
