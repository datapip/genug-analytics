import type { Request, Response, NextFunction } from "express";
import { timingSafeStringEqual } from "./auth.js";
import {
  createRequestLimiter,
  MCP_KEYLESS_MAX_PER_WINDOW,
  MCP_MAX_PER_WINDOW,
} from "./rateLimit.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

// Hosted agents (claude.ai and others) call from addresses shared with
// every other customer of that vendor, so anything counted per address
// alone is counted across strangers too. A request with the right key
// is the one thing a stranger cannot send, so the key decides which
// budget a request spends: the owner's, or everyone else's.
//
// There is no failed-attempt lockout here any more. A lockout that
// refuses the right key is one any stranger on the same address can
// trigger; one that lets the right key through still tells a guesser
// right from wrong, so it bounds nothing. What bounds guessing is the
// keyless budget and the key's length (parseMcpApiKey in env.ts).
export function createMcpAuthMiddleware(
  apiKey: string,
  limiters: { keyed: Middleware; keyless: Middleware } = {
    keyed: createRequestLimiter(MCP_MAX_PER_WINDOW, "/mcp"),
    keyless: createRequestLimiter(MCP_KEYLESS_MAX_PER_WINDOW, "/mcp keyless"),
  },
): Middleware {
  return function requireApiKey(req, res, next): void {
    // Compared once, here. A second comparison elsewhere that read the
    // header slightly differently would let a stranger into the owner's
    // budget.
    const header = req.headers.authorization ?? "";
    if (timingSafeStringEqual(header, `Bearer ${apiKey}`)) {
      limiters.keyed(req, res, next);
      return;
    }
    limiters.keyless(req, res, () => {
      res.status(401).json({ error: "unauthorized" });
    });
  };
}
