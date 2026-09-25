import { getRecentEvents } from "../lib/recentEvents.js";
import { getTopRejectedEvents } from "../lib/rejectedEvents.js";
import { getBotActivityCount } from "../lib/botActivity.js";
import { getOrphanedEvents } from "../lib/orphanedEvents.js";
import {
  eventRegistry,
  schemaErrors,
  eventsSource,
} from "@genug/schema-registry";
import {
  periodInput,
  limitInput,
  jsonContent,
  rankedShape,
  type ToolRegistrar,
  VISITOR_TEXT_CAVEAT,
} from "./shared.js";

// Kept apart from registerDiagnosticTools below, and from
// mcp/tools.ts's toolModules, the same way registerAdminTools is: this
// is the only diagnostic tool that hands back raw rows (url, props,
// referrer verbatim) rather than an aggregate, so it is the one
// docs/decisions.md already named as "the one a cautious deployment can
// unregister" — READ_ONLY now does that for it, on the same reasoning
// as a write: a public MCP key should not double as a raw event export.
export const registerRecentEventsTool: ToolRegistrar = (server, db) => {
  server.registerTool(
    "get_recent_events",
    {
      description: `Get the most recent raw events across all event types, newest first. Useful for spot-checking that tracking is actually working, or seeing exactly what's being recorded right now — not for aggregate analysis, which the other tools already cover. Each row carries the event name, url, ts, props, and the envelope fields a spot check turns on: sessionId (are two hits one visit), consentMode (did the consent banner switch modes), referrer, deviceType and browser. visitor_id is deliberately not included. Unusually large rows can mean fewer rows than limit come back; a second text block says so when that happens. ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        limit: limitInput("Max number of events to return"),
      },
    },
    async ({ limit }) => {
      const { rows, truncated } = getRecentEvents(db, limit);
      const result = jsonContent(rows);
      if (truncated) {
        // A second block rather than a wrapper object, so the first
        // stays the same plain array it has always been.
        result.content.push({
          type: "text",
          text: `Only the newest ${rows.length} of the ${limit} requested events are shown: the rest would have made this answer too large. Ask for a smaller limit, or use the aggregate tools for anything beyond a spot check.`,
        });
      }
      return result;
    },
  );
};

// "Is tracking actually working" — quality-assurance signals rather
// than analytics. None of these describe visitor behaviour; they
// describe the health of the pipeline itself. Unlike get_recent_events
// above, none returns a raw row, so all four stay registered under
// READ_ONLY — a demo deployment still needs to see that tracking works.
export const registerDiagnosticTools: ToolRegistrar = (server, db) => {
  server.registerTool(
    "get_orphaned_events",
    {
      description:
        "Get stored events whose type is no longer in the schema registry: per event name, how many events there are and when the last one arrived. These are real events that the registry has lost track of, and they can only be caused by the site owner renaming or deleting an event type — never by visitor behaviour or a tracking bug, because an unregistered event name is rejected before it is ever stored. Distinct from get_top_rejected_events, which reports requests that never became data at all. An empty result is the normal, healthy case. When it is not empty, be careful about what you conclude from other tools for the period these rows cover: get_top_events and get_recent_events still show them under the old name, but no tool will accept that name as an argument, and any question answered through a registered name excludes them. If the renamed event was the page-view event, every page-scoped answer (top pages, entry/exit/bounce pages, and the viewEvents half of get_traffic_summary) is missing that history, and those page views are counted as interactionEvents instead — so the totals look plausible while the breakdown is wrong. Say that plainly rather than reporting the numbers as if they were complete. The site owner fixes this themselves: in the cockpit's Schema registry card, renaming the event to the name these rows carry hands them back to it, and renaming it forward again with the offered checkbox ticked carries them across; otherwise it is a SQL UPDATE renaming the old value to the new one. You cannot do either, and should not imply otherwise.",
      inputSchema: {},
    },
    async () => {
      return jsonContent(getOrphanedEvents(db, Object.keys(eventRegistry)));
    },
  );

  server.registerTool(
    "get_schema_errors",
    {
      description:
        "Get the event definition files the server could not load, with the file name and what was wrong with each — a file the checker rejected is skipped rather than allowed to stop the server, so its event is silently not registered: every request for it is rejected as unknown_event_type, and no tool will accept its name. An empty list is the normal, healthy case. When it is not empty, that is the first thing to tell the site owner when they ask why an event records nothing; the cockpit's Schema registry card shows the same list. Also returns `source`, the directory the definitions are read from.",
      inputSchema: {},
    },
    async () => {
      // Live bindings, read per call (see AGENTS.md): a reload replaces
      // them, and a module-level copy would report the errors of the
      // registry that was loaded at startup forever.
      return jsonContent({ source: eventsSource, errors: schemaErrors });
    },
  );

  server.registerTool(
    "get_top_rejected_events",
    {
      description: `Get the requests the server rejected for not matching a schema (a malformed envelope, an unregistered event type, or props that don't match that event's own schema), grouped by reason and event name — for an event that is rejected as unknown although the owner defined it, check get_schema_errors first, ranked by number of requests descending. Each group includes lastDetail, a short summary of the most recent occurrence's actual validation failure (e.g. "props.value: Expected number, received string") for invalid_envelope/invalid_props — null for unknown_event_type, where the event name itself is already the useful detail. Each group also includes lastSeen, the timestamp of that most recent occurrence — use it before calling a nonzero count a live problem, since a group that stopped days ago is an integration the owner has already fixed. A quality-assurance signal, not analytics: a nonzero, growing count usually means a tracking integration bug (e.g. a typo'd event name showing up repeatedly under "unknown_event_type") rather than real visitor behavior — these requests never became rows in the real events data. ${rankedShape("requests")} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        ...periodInput,
        limit: limitInput("Max number of reason/event combinations to return"),
      },
    },
    async ({ from, to, limit }) => {
      return jsonContent(getTopRejectedEvents(db, { from, to }, limit));
    },
  );

  server.registerTool(
    "get_bot_activity",
    {
      description:
        "Get how many requests to /events were dropped as bot/crawler traffic in a given time period, as { requests }. Best-effort only (see lib/bots.ts): catches bots that identify themselves honestly, not one deliberately spoofing a real browser's User-Agent. A rough volume signal, not a precise count — e.g. to notice an unusual crawler surge — not something to build alerting logic on top of.",
      inputSchema: periodInput,
    },
    async ({ from, to }) => {
      return jsonContent({
        requests: getBotActivityCount(db, { from, to }),
      });
    },
  );
};
