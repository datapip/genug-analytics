import { z } from "zod";
import { eventRegistry } from "@genug/schema-registry";
import {
  getTopEvents,
  getEventTrend,
  getEntryEvents,
  getExitEvents,
  getEventsByProperty,
  getPropertySum,
} from "../lib/events.js";
import { getStepsFunnel } from "../lib/funnel.js";
import {
  periodInput,
  segmentInput,
  resolveSegment,
  trendLengthError,
  MAX_TREND_DAYS,
  limitInput,
  jsonContent,
  rankedShape,
  toolError,
  isRegisteredEvent,
  hasDeclaredProp,
  eventProps,
  unknownEventError,
  unknownPropError,
  SEGMENT_HINT,
  type ToolRegistrar,
  VISITOR_TEXT_CAVEAT,
} from "./shared.js";

// "What happened, and in what order" — everything keyed on event types
// and their props rather than on pages, so unlike content.ts none of
// these need a page-view event to exist at all.
export const registerEventTools: ToolRegistrar = (server, db) => {
  server.registerTool(
    "get_top_events",
    {
      description: `Get the most-frequent event types (any registered event, not just page_view) for a given time period, ranked by events descending. Use this for a general 'what's happening' overview; use get_top_pages specifically for page view rankings. ${rankedShape("events")} ${SEGMENT_HINT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of event types to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getTopEvents(db, { from, to }, limit, resolved.clause),
      );
    },
  );

  server.registerTool(
    "get_event_trend",
    {
      description: `Get one event type over time: per UTC calendar day in the period, how many times it happened (events), in how many sessions, and by how many distinct visitors — zero-filled for days it didn't happen, so a quiet day reads as a dip. Use this for "did signups grow this month"; get_traffic_by_day is the same shape for all traffic together. Sessions and visitors are counted per day, so one spanning midnight is in both, and a consentless visitor is a new id each day by design. The period is limited to ${MAX_TREND_DAYS} days. ${SEGMENT_HINT}`,
      inputSchema: {
        event: z
          .string()
          .describe(
            'Registered event type name to trend, e.g. "newsletter_signup"',
          ),
        ...periodInput,
        ...segmentInput,
      },
    },
    async ({ event, from, to, segment }) => {
      if (!isRegisteredEvent(event)) return unknownEventError(event);
      const tooLong = trendLengthError(from, to, "get_event_trend");
      if (tooLong) return tooLong;
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getEventTrend(db, event, { from, to }, resolved.clause),
      );
    },
  );

  server.registerTool(
    "get_top_entry_events",
    {
      description: `Get the event types that most often start a session, ranked by number of sessions, descending. Counts sessions that STARTED in the period, by their genuine first event — a session already under way when the period began is not counted. Unlike get_top_entry_pages, this ranks by event type rather than page, and works regardless of whether this deployment tracks page views at all — useful when the url barely varies (e.g. a single-page app that never updates the address bar), where a page-based breakdown wouldn't be meaningful. ${rankedShape("sessions")} ${SEGMENT_HINT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of event types to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getEntryEvents(db, { from, to }, limit, resolved.clause),
      );
    },
  );

  server.registerTool(
    "get_top_exit_events",
    {
      description: `Get the event types that most often end a session, ranked by number of sessions, descending. Counts sessions that STARTED in the period, by their genuine last event even where it fell after the period's end. Same relationship to get_top_exit_pages as get_top_entry_events has to get_top_entry_pages. ${rankedShape("sessions")} ${SEGMENT_HINT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of event types to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getExitEvents(db, { from, to }, limit, resolved.clause),
      );
    },
  );

  server.registerTool(
    "get_events_by_property",
    {
      description: `Break down one event type's occurrences by one of its own declared prop values, e.g. product_added_to_cart grouped by product_id, or outbound_link_click grouped by target_host. Read the schema-registry resource first to see which prop names a given event type actually has. Each row is one value with the number of events that carried it. If the prop is marked "list": true there, it holds several values per event (tags, categories) and each is counted separately — one event adds to the count of every value it carries, so these counts add up to MORE than the number of events, and a percentage out of the event count is not meaningful (total is then the sum of those per-value counts, not the number of events). For a prop that is not a list the counts are one per event and do sum to the total. ${rankedShape("events")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        event: z
          .string()
          .describe(
            'Registered event type name to break down, e.g. "product_added_to_cart"',
          ),
        property: z
          .string()
          .describe(
            'Prop name to group by, as declared in that event type\'s schema, e.g. "product_id"',
          ),
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of distinct values to return"),
      },
    },
    async ({ event, property, from, to, segment, limit }) => {
      if (!isRegisteredEvent(event)) return unknownEventError(event);
      if (!hasDeclaredProp(event, property)) {
        return unknownPropError(event, property);
      }
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getEventsByProperty(
          db,
          event,
          property,
          { from, to },
          limit,
          eventProps(event)[property]!.list,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_property_sum",
    {
      description: `Sum and average one event type's numeric prop across every occurrence in a period, e.g. total and average revenue from order_completed's "value" prop. Read the schema-registry resource first to see which prop names a given event type actually has and which are numeric — this only works on numeric props (an order_completed grouped by product_id is get_events_by_property's job, not this one). \`values\` is the number of values that went into the sum, which \`average\` is the average over. For an ordinary prop that is one per event; for a prop marked "list": true it is one per value, so an event carrying three numbers contributes three — \`values\` is then larger than the number of events. ${SEGMENT_HINT}`,
      inputSchema: {
        event: z
          .string()
          .describe(
            'Registered event type name to sum, e.g. "order_completed"',
          ),
        property: z
          .string()
          .describe(
            'Numeric prop name to sum, as declared in that event type\'s schema, e.g. "value"',
          ),
        ...periodInput,
        ...segmentInput,
      },
    },
    async ({ event, property, from, to, segment }) => {
      if (!isRegisteredEvent(event)) return unknownEventError(event);
      if (!hasDeclaredProp(event, property)) {
        return unknownPropError(event, property);
      }

      // Checked against the registry's declared type rather than the
      // stored data: SUM over a non-numeric prop would silently return
      // 0, which reads as "no revenue" rather than "wrong prop".
      const prop = eventProps(event)[property]!;
      if (prop.type !== "number") {
        return toolError(
          `Prop "${property}" on event type "${event}" isn't numeric (it is declared as ${prop.type}) — get_property_sum only works on numeric props. Use get_events_by_property to break down a non-numeric prop instead.`,
        );
      }

      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getPropertySum(
          db,
          event,
          property,
          { from, to },
          prop.list,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_steps_funnel",
    {
      description: `See how many sessions (or visitors) reached each step of an ordered sequence of event types within a period, e.g. ["product_viewed", "added_to_cart", "checkout_completed"]. A step only counts if it happened after the previous step was reached. Steps can be any registered event types, in any order you choose — read the schema-registry resource first to see what this deployment actually tracks. \`scope\` decides what walks the funnel. "session" (the default) counts sessions that completed the steps within one visit, and is correct for every visitor. In either scope only events inside the period count, so a session that reached a later step after the period's end is not a conversion here. "visitor" follows a visitor across visits — but consentless visitors (see get_consent_breakdown) get a new visitor_id every UTC day by design, so in that scope one of them who viewed at 23:50 and bought at 00:10 is two people who each did half the funnel, and a funnel spanning days only ever counts consentful visitors. Use "visitor" for a mostly-consentful deployment and multi-visit questions; otherwise leave the default. Returns the scope, and per step the number of sessions or visitors that reached it (named for the unit) plus its conversion rate relative to the first step, 0-1. ${SEGMENT_HINT} The segment decides who enters the funnel at step one; in visitor scope the later steps then follow those visitors wherever they went, so a visitor who entered on mobile and completed on desktop still converts under a mobile segment.`,
      inputSchema: {
        steps: z
          .array(z.string())
          .min(2)
          .describe(
            "Ordered list of registered event type names representing the funnel, earliest step first",
          ),
        scope: z
          .enum(["session", "visitor"])
          .default("session")
          .describe(
            'What walks the funnel: "session" (default; all steps within one visit, correct for every visitor) or "visitor" (across visits; only reliable for consentful visitors, since consentless ids rotate daily)',
          ),
        ...periodInput,
        ...segmentInput,
      },
    },
    async ({ steps, scope, from, to, segment }) => {
      const unknownSteps = steps.filter((step) => !isRegisteredEvent(step));
      if (unknownSteps.length > 0) {
        return toolError(
          `Unknown event type(s): ${unknownSteps.join(", ")}. Valid event types: ${Object.keys(eventRegistry).join(", ")}`,
        );
      }
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      // The lib returns one shape for both scopes; the agent gets the
      // field named for its unit, per the rule that a count says what
      // it counts.
      const unit = scope === "session" ? "sessions" : "visitors";
      const steps_ = getStepsFunnel(
        db,
        steps,
        { from, to },
        scope,
        resolved.clause,
      ).map(({ event, reached, conversionRate }) => ({
        event,
        [unit]: reached,
        conversionRate,
      }));
      return jsonContent({ scope, steps: steps_ });
    },
  );
};
