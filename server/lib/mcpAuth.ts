import type { Request, Response, NextFunction } from "express";
import { timingSafeStringEqual } from "./auth.js";
import {
  createRequestLimiter,
  MCP_KEYLESS_MAX_PER_WINDOW,
  MCP_MAX_PER_WINDOW,
} from "./rateLimit.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

// Hosted agents (claude.ai and others) call from addresses they share
// with all their other customers, so a limit per address alone would be
// shared with strangers. A stranger can't send the right key, so the key
// decides which rate limit a request counts against: the owner's, or the
// one for everyone else.
//
// There is deliberately no lockout after failed attempts. A lockout that
// also blocks the right key lets any stranger on the same address lock
// the owner out; one that lets the right key through still tells a
// guesser when they are right, so it limits nothing. Guessing is limited
// by the rate limit for requests without the key and by the key's length
// (shortMcpApiKeyWarning in env.ts warns when it is short).
export function createMcpAuthMiddleware(
  apiKey: string,
  limiters: { keyed: Middleware; keyless: Middleware } = {
    keyed: createRequestLimiter(MCP_MAX_PER_WINDOW, "/mcp"),
    keyless: createRequestLimiter(MCP_KEYLESS_MAX_PER_WINDOW, "/mcp keyless"),
  },
): Middleware {
  return function requireApiKey(req, res, next): void {
    // The key is checked only here. A second check elsewhere that read
    // the header slightly differently could put a stranger under the
    // owner's rate limit.
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
