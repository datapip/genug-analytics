import type { Request, Response, NextFunction } from "express";
import { timingSafeStringEqual } from "./auth.js";
import {
  createFailedAttemptLimiter,
  type FailedAttemptLimiter,
} from "./rateLimit.js";

// Counted per failed attempt, not per request — an agent working
// through a question legitimately fires many tool calls in a burst, and
// throttling those would penalize correct credentials while barely
// slowing a guesser.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export function createMcpAuthMiddleware(
  apiKey: string,
  limiter: FailedAttemptLimiter = createFailedAttemptLimiter(
    MAX_FAILURES,
    FAILURE_WINDOW_MS,
  ),
) {
  return function requireApiKey(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip = req.ip ?? "unknown";
    if (limiter.isBlocked(ip)) {
      // The other 429 an agent can get here is the request limit, which
      // clears in under a minute. This one holds for fifteen, so it says
      // so rather than leaving the two indistinguishable.
      const retryAfterSeconds = limiter.retryAfterSeconds(ip);
      res.set("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "too many failed attempts",
        retryAfterSeconds,
      });
      return;
    }

    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (!timingSafeStringEqual(header, `Bearer ${apiKey}`)) {
      // Only a request that actually presented a bearer token has
      // guessed at anything — same reasoning as the identical guard in
      // lib/cockpitAuth.ts. A request with no Authorization header at
      // all is not an attempt to guess, and counting it anyway let
      // anyone lock the site owner's own agent out of MCP for fifteen
      // minutes at a time with a handful of bare, unauthenticated POSTs
      // — no key required to cause it.
      if (scheme === "Bearer" && token) limiter.recordFailure(ip);
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}
