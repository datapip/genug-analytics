import { Router, json, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type Database from "better-sqlite3";
import { createMcpServer } from "../mcp/tools.js";
import { createMcpAuthMiddleware } from "../lib/mcpAuth.js";
import { logError } from "../lib/logger.js";

export interface McpRouterDeps {
  db: Database.Database;
  mcpApiKey: string;
  // Leaves the writing tools and get_recent_events unregistered.
  readOnly: boolean;
  timezone: string;
  // Named in the server's name and instructions (mcp/tools.ts).
  siteHosts: ReadonlySet<string>;
}

function methodNotAllowed(req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

export function createMcpRouter(deps: McpRouterDeps): Router {
  const router = Router();
  // Checks the key and the per-address limits in one step, so a flood is
  // bounded whether or not it carries the key. See lib/mcpAuth.ts.
  router.use(createMcpAuthMiddleware(deps.mcpApiKey));
  router.post("/", parseMcpBody, (req, res) =>
    handleMcpRequest(deps, req, res),
  );
  router.get("/", methodNotAllowed);
  router.delete("/", methodNotAllowed);
  return router;
}

// One JSON-RPC message per request, at most 16kb. The transport would
// accept an array of messages in one request, so a single request could
// carry hundreds of tool calls and get around the rate limit. The MCP spec
// no longer allows such batches, so no client needs them. They are
// refused here, before any query runs.
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

async function handleMcpRequest(
  { db, readOnly, timezone, siteHosts }: McpRouterDeps,
  req: Request,
  res: Response,
): Promise<void> {
  if (refusesBatch(req, res)) return;

  // Stateless: a new server and transport for each request, with no
  // session. Every tool answers in one response, so nothing needs to be
  // kept between requests.
  const server = createMcpServer(db, {
    readOnly,
    timezone,
    siteHosts: [...siteHosts],
  });
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
}
