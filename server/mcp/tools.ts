import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import {
  invertedPeriodError,
  SERVER_INSTRUCTIONS,
  type ToolRegistrar,
} from "./shared.js";
import { registerRegistryTools } from "./registry.js";
import { registerContextResources } from "./context.js";
import { registerTrafficTools } from "./traffic.js";
import { registerContentTools } from "./content.js";
import { registerEventTools } from "./events.js";
import { registerAudienceTools } from "./audience.js";
import {
  registerDiagnosticTools,
  registerRecentEventsTool,
} from "./diagnostics.js";
import { registerAdminTools } from "./admin.js";
import { VERSION } from "../lib/version.js";

// The tools themselves live in the modules below, grouped by the kind of
// question they answer. This file had grown to ~900 lines with all of
// them inlined in one function, which made it by far the largest source
// file in the project and buried the wiring below in the middle of it.
//
// Adding a tool means editing whichever module it belongs to — or adding
// a new one to this list, which is the only place that needs to know a
// module exists.
const toolModules: ToolRegistrar[] = [
  registerRegistryTools, // what this deployment tracks at all
  registerContextResources, // what its owner wants the agent to know
  registerTrafficTools, // how much traffic, and when
  registerContentTools, // which pages, and where visitors came from
  registerEventTools, // what happened, and in what order
  registerAudienceTools, // who is visiting
  registerDiagnosticTools, // is tracking actually working
];

// Kept apart from the list above rather than filtered out of it: a
// read-only deployment (READ_ONLY=true, see lib/env.ts) is one whose
// MCP key is public, and the whole promise there is that nothing behind
// the key can write. That is easier to believe of a module that was
// never registered than of a tool that checks a flag inside its
// handler. mcp/admin.ts is the only module that writes anything, so
// this is the one line read-only mode has to know about.
const writingToolModules: ToolRegistrar[] = [
  registerAdminTools, // the one tool that writes
];

// Same treatment, different reason: get_recent_events doesn't write,
// but it is the one tool that hands the agent raw, unaggregated visitor
// data (see diagnostics.ts and docs/decisions.md, "the agent reads
// attacker-controlled text"). A public MCP key shouldn't double as a
// raw event export any more than it should double as a write key.
const rawDataToolModules: ToolRegistrar[] = [registerRecentEventsTool];

export interface McpServerOptions {
  // Skips every tool that writes. The routes read it from the
  // environment; tests pass it directly.
  readOnly?: boolean;
}

// Rejects an inverted period before the handler runs, for every tool
// that takes one — the ~25 of them are found by their input shape rather
// than by a hand-kept list, so a new period-taking tool is covered the
// day it's written. Tools without both bounds (get_recent_events,
// get_orphaned_events, get_schema_errors, list_event_types,
// delete_visitor_data, and get_cohort_return with its two named pairs)
// are handed back untouched.
function guardPeriod(
  config: { inputSchema?: Record<string, unknown> },
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
) {
  const shape = config.inputSchema;
  if (!shape || !("from" in shape) || !("to" in shape)) return handler;

  return async (args: Record<string, unknown>, extra: unknown) => {
    const error = invertedPeriodError(args.from as string, args.to as string);
    return error ?? (await handler(args, extra));
  };
}

// Every period-taking query over `events` takes a segment (AGENTS.md),
// and a tool that leaves it out does not fail: the SDK drops the unknown
// argument, and the agent gets whole-site numbers it reads as the
// segment's. Two tools slipped through that way, so this fails the
// server at startup instead. The exempt ones read tables with no
// session_id to narrow by.
const PERIOD_WITHOUT_SEGMENT = new Set([
  "get_top_rejected_events", // rejected_events
  "get_bot_activity", // bot_activity
]);

function requireSegment(
  name: string,
  config: { inputSchema?: Record<string, unknown> },
): void {
  const shape = config.inputSchema;
  if (!shape || !("from" in shape) || !("to" in shape)) return;
  if ("segment" in shape || PERIOD_WITHOUT_SEGMENT.has(name)) return;
  throw new Error(
    `MCP tool "${name}" takes a period but no segment. Spread segmentInput into its inputSchema and call resolveSegment, or add it to PERIOD_WITHOUT_SEGMENT in mcp/tools.ts with the reason.`,
  );
}

export interface ToolSummary {
  name: string;
  description: string;
}

// Populated as a side effect of createMcpServer below (via the
// registerTool wrapper), not hand-maintained — so a deployment that adds
// its own custom tool shows up in the cockpit's tool overview for free,
// with no second list to keep in sync. One manifest per mode: a
// read-only server registers fewer tools, and the cockpit must list
// what the agent can actually call, not what the image ships.
const manifests = new Map<boolean, ToolSummary[]>();

export function getToolManifest(
  db: Database.Database,
  options: McpServerOptions = {},
): ToolSummary[] {
  const readOnly = options.readOnly === true;
  if (!manifests.has(readOnly)) {
    createMcpServer(db, options);
  }
  return manifests.get(readOnly) ?? [];
}

export function createMcpServer(
  db: Database.Database,
  options: McpServerOptions = {},
): McpServer {
  const readOnly = options.readOnly === true;
  const server = new McpServer(
    { name: "genug", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Wraps registerTool once, before any module runs, so every tool they
  // register (unchanged) is both recorded in the manifest and given the
  // period guard above — capturing exactly what's actually registered
  // rather than a separately hand-written list that could drift from it.
  // TypeScript can't carry the specific overload through a reassignment
  // like this, so the cast is a deliberate, narrow escape hatch: the
  // wrapper only reads `name`/`description`/`inputSchema` and forwards
  // name and config unchanged, so it's correct by construction even
  // though the type system can't see that.
  const manifest: ToolSummary[] = [];
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: { description?: string; inputSchema?: Record<string, unknown> },
    handler: (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>,
  ) => {
    requireSegment(name, config);
    manifest.push({ name, description: config.description ?? "" });
    return (
      originalRegisterTool as unknown as (
        ...args: unknown[]
      ) => ReturnType<typeof originalRegisterTool>
    )(name, config, guardPeriod(config, handler));
  }) as typeof server.registerTool;

  const modules = readOnly
    ? toolModules
    : [...toolModules, ...writingToolModules, ...rawDataToolModules];
  for (const registerTools of modules) {
    registerTools(server, db);
  }

  manifests.set(readOnly, manifest);
  return server;
}
