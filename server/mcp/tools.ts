import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type Database from "better-sqlite3";
import {
  invertedPeriodError,
  serverInstructions,
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

// The tool modules, grouped by the kind of question they answer. To add
// a tool, add it to the right module, or add a new module to this list.
const toolModules: ToolRegistrar[] = [
  registerRegistryTools, // what this deployment tracks at all
  registerContextResources, // what its owner wants the agent to know
  registerTrafficTools, // how much traffic, and when
  registerContentTools, // which pages, and where visitors came from
  registerEventTools, // what happened, and in what order
  registerAudienceTools, // who is visiting
  registerDiagnosticTools, // is tracking actually working
];

// A separate list, because READ_ONLY=true (see lib/env.ts) doesn't
// register these at all: with a public MCP key nothing may write, and a
// module that isn't registered can't. mcp/admin.ts is the only module
// that writes.
const writingToolModules: ToolRegistrar[] = [
  registerAdminTools, // the two tools that write
];

// Also left out under READ_ONLY: get_recent_events writes nothing, but it
// returns raw visitor data rather than totals (see diagnostics.ts and
// "the agent reads attacker-controlled text" in docs/decisions.md), and
// a public key shouldn't allow exporting it.
// The cockpit's #tools-read-only-note (plain HTML) counts the tools these
// two lists leave out. Update it when they change.
const rawDataToolModules: ToolRegistrar[] = [registerRecentEventsTool];

export interface McpServerOptions {
  // Leaves out every tool that writes.
  readOnly?: boolean;
  // The site's time zone (TIMEZONE). Required: tool descriptions name it,
  // and a plain date means a day in that zone.
  timezone: string;
  // The sites ALLOWED_ORIGIN lists (config.siteHosts), used in the
  // server's name and instructions. No tool description uses them, so
  // the cockpit's tool list is built without them.
  siteHosts?: readonly string[];
}

// Rejects a period whose start is after its end, before the tool runs.
// Tools with a period are recognised by having both `from` and `to`, so
// a new tool is covered automatically. Tools without them
// (get_recent_events, get_orphaned_events, get_schema_errors,
// list_event_types, delete_visitor_data, and get_cohort_return with its
// differently named periods) are left unchanged.
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

// Every tool with a period over `events` must take a segment (see
// AGENTS.md). A tool without one doesn't fail: the SDK ignores the
// unknown argument, and the agent gets numbers for the whole site while
// believing they are for the segment. So the server refuses to start
// instead. The tools listed here read tables without a session_id.
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

// Hints a tool gives the client about itself, so a client that asks
// before a write (Claude does) knows which calls to ask about. Visitor
// text reaches the agent through most tools, and text that talks it into
// deleting a visitor's data is exactly what a client should stop for.
// Read-only tools get their hints added below. Writing tools must state
// theirs in admin.ts, because a writing tool marked read-only would be
// shown to the client as safe to call without asking.
const READ_TOOL_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  // Every tool answers from this deployment's own database and files.
  openWorldHint: false,
};

function annotate(
  name: string,
  config: { annotations?: ToolAnnotations },
  writes: boolean,
): ToolAnnotations {
  const given = config.annotations;
  if (writes) {
    if (given?.readOnlyHint !== false || given.destructiveHint === undefined) {
      throw new Error(
        `MCP tool "${name}" is registered as a writing tool but does not say so. Give it annotations with readOnlyHint: false and an explicit destructiveHint.`,
      );
    }
    return given;
  }
  if (given?.readOnlyHint === false) {
    throw new Error(
      `MCP tool "${name}" says it writes, but is not in a writing module. Move it to mcp/admin.ts, which READ_ONLY=true leaves unregistered.`,
    );
  }
  return { ...READ_TOOL_ANNOTATIONS, ...given };
}

export interface ToolSummary {
  name: string;
  description: string;
}

// The list of tools for the cockpit, filled in by createMcpServer below
// as tools are registered, so a deployment's own tools show up without a
// second list. One list per mode, because read-only mode has fewer
// tools, and per time zone, because descriptions name it.
const manifests = new Map<string, ToolSummary[]>();

function manifestKey(readOnly: boolean, timezone: string): string {
  return `${readOnly}:${timezone}`;
}

export function getToolManifest(
  db: Database.Database,
  options: McpServerOptions,
): ToolSummary[] {
  const key = manifestKey(options.readOnly === true, options.timezone);
  if (!manifests.has(key)) {
    createMcpServer(db, options);
  }
  return manifests.get(key) ?? [];
}

// The name a client shows in its list of servers, so three connected
// installations aren't three entries called "genug".
function serverName(siteHosts: readonly string[]): string {
  return siteHosts.length > 0 ? `genug (${siteHosts.join(", ")})` : "genug";
}

export function createMcpServer(
  db: Database.Database,
  options: McpServerOptions,
): McpServer {
  const readOnly = options.readOnly === true;
  const { timezone } = options;
  const siteHosts = options.siteHosts ?? [];
  const server = new McpServer(
    { name: serverName(siteHosts), version: VERSION },
    { instructions: serverInstructions(siteHosts) },
  );

  // Wrap registerTool before any module runs, so every tool is added to
  // the list above and gets the period check. TypeScript can't keep the
  // method's overloads through this reassignment, hence the cast. It is
  // safe: the wrapper only reads `name`, `description` and `inputSchema`
  // and passes everything on unchanged.
  const manifest: ToolSummary[] = [];
  // The group the loop below is registering, so the wrapper can give
  // each tool the hints for its module (see annotate).
  let registeringWrites = false;
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: {
      description?: string;
      inputSchema?: Record<string, unknown>;
      annotations?: ToolAnnotations;
    },
    handler: (
      args: Record<string, unknown>,
      extra: unknown,
    ) => Promise<unknown>,
  ) => {
    requireSegment(name, config);
    const annotations = annotate(name, config, registeringWrites);
    manifest.push({ name, description: config.description ?? "" });
    return (
      originalRegisterTool as unknown as (
        ...args: unknown[]
      ) => ReturnType<typeof originalRegisterTool>
    )(name, { ...config, annotations }, guardPeriod(config, handler));
  }) as typeof server.registerTool;

  const groups: [ToolRegistrar[], boolean][] = readOnly
    ? [[toolModules, false]]
    : [
        [toolModules, false],
        [writingToolModules, true],
        [rawDataToolModules, false],
      ];
  for (const [modules, writes] of groups) {
    registeringWrites = writes;
    for (const registerTools of modules) {
      registerTools(server, db, { timezone });
    }
  }

  manifests.set(manifestKey(readOnly, timezone), manifest);
  return server;
}
