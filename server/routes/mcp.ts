import { Router, json, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { db } from "../db/index.js";
import { createMcpServer } from "../mcp/tools.js";
import { parseReadOnly, requireEnv } from "../lib/env.js";
import { createMcpAuthMiddleware } from "../lib/mcpAuth.js";
import { rateLimitMcp } from "../lib/rateLimit.js";
import { logError } from "../lib/logger.js";

const mcpApiKey = requireEnv("MCP_API_KEY");
// Read at module scope like the key above. Every module that needs it
// parses the same variable itself; whichever is imported first is the
// one whose throw stops startup, which is enough — a bad value cannot
// reach a listening server through any of them.
const readOnly = parseReadOnly(process.env.READ_ONLY);

const requireApiKey = createMcpAuthMiddleware(mcpApiKey);

function methodNotAllowed(req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

export const mcpRouter: Router = Router();

// The request limiter sits in front of the key check on purpose: a
// flood is bounded whether or not it carries the key. The failed-attempt
// limiter inside requireApiKey is the one that makes the key hard to
// guess; this one makes a known key hard to abuse.
mcpRouter.use(rateLimitMcp);
mcpRouter.use(requireApiKey);

// One JSON-RPC message per request, at 16kb. Express's default body
// limit is 100kb, and the transport accepts an *array* of messages in
// one POST — so without this a single allowed request carries hundreds
// of tool calls and the per-minute limiter above bounds almost nothing.
// Batching was removed from the MCP spec in 2025-06-18, so refusing it
// costs no client anything, and it is refused here rather than inside
// the transport because the point is to answer before any query runs.
const parseMcpBody = json({ limit: "16kb" });

function refusesBatch(req: Request, res: Response): boolean {
  if (!Array.isArray(req.body)) return false;
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32600,
      message:
        "Batched requests are not accepted. Send one JSON-RPC message per request.",
    },
    id: null,
  });
  return true;
}

mcpRouter.post("/", parseMcpBody, async (req: Request, res: Response) => {
  if (refusesBatch(req, res)) return;

  // Stateless mode (see mcp/tools.ts): a fresh server + transport per
  // request, no session tracking — this server only does simple one-shot
  // query tools, no long-running/streaming operations.
  const server = createMcpServer(db, { readOnly });
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    logError("Error handling MCP request", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

mcpRouter.get("/", methodNotAllowed);
mcpRouter.delete("/", methodNotAllowed);
