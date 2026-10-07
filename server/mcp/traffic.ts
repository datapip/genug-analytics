import { z } from "zod";
import { pageViewEventType } from "@genug/schema-registry";
import {
  getTrafficSummary,
  getTrafficByDay,
  getTrafficByDayOfWeek,
  getTrafficByHour,
  getSessionSummary,
  hasAnyEvents,
} from "../lib/traffic.js";
import {
  BASELINE_PERIODS,
  getTrafficChange,
  MAX_CHANGE_DAYS,
} from "../lib/trafficChange.js";
import { enumerateDays } from "../lib/timezone.js";
import {
  periodInput,
  resolveSegment,
  isRegisteredEvent,
  unknownEventError,
  toolError,
  segmentInput,
  withSegment,
  trendLengthError,
  MAX_TREND_DAYS,
  jsonContent,
  SEGMENT_HINT,
  type ToolRegistrar,
} from "./shared.js";

// "How much traffic, and when" — the aggregate shape of activity over a
// period, however it's sliced (whole period, per day, per weekday, per
// hour), and for whichever sessions a segment selects.

const TRAFFIC_FIELDS =
  "sessions, visitors (distinct visitor ids — over several days a consentless visitor counts once per day they came, since their id rotates daily by design; see get_consent_breakdown), interactionEvents (every non-page-view event) and viewEvents (the page-view event). interactionEvents and viewEvents are additive — they don't overlap.";

export const registerTrafficTools: ToolRegistrar = (
  server,
  db,
  { timezone },
) => {
  const period = periodInput(timezone);
  server.registerTool(
    "get_traffic_summary",
    {
      description: `Get aggregate traffic numbers for a given time period: ${TRAFFIC_FIELDS} Sessions and visitors are those active in the period, so a session under way at midnight counts in both adjacent periods. ${SEGMENT_HINT}`,
      inputSchema: { ...period, ...segmentInput },
    },
    async ({ from, to, segment }) => {
      return withSegment(db, segment, { from, to }, (clause) => {
        const summary = getTrafficSummary(
          db,
          { from, to },
          pageViewEventType,
          clause,
        );
        // A zero-everywhere summary is ambiguous to an agent — genuinely quiet
        // period, or has the client script never actually reached this server?
        // Only the latter case gets a note; a quiet period within otherwise-
        // present data is a normal, correct answer. sessions === 0 already
        // implies no events matched at all, so it alone is enough to check.
        const result =
          summary.sessions === 0 && !hasAnyEvents(db)
            ? {
                ...summary,
                note: "No events have ever been recorded on this server. This usually means the client script isn't installed on the tracked site yet, or ALLOWED_ORIGIN doesn't match its origin (the browser would silently block the request as a CORS error).",
              }
            : summary;
        return jsonContent(result);
      });
    },
  );

  server.registerTool(
    "get_traffic_by_day",
    {
      description: `Get traffic (${TRAFFIC_FIELDS}) broken down by calendar day for a given time period, one entry per day, zero-filled for days with no activity. Use this to see trends over time, e.g. whether traffic is growing or spiking; for one event's trend use get_event_trend. Days are calendar days in the site's time zone (${timezone}), not the visitor's local day or UTC. Where clocks change, that day lasts 23 or 25 hours and shows a small dip or bump that is not a real change in traffic. Sessions and visitors are counted per day, so a session spanning midnight is counted in both — these daily counts deliberately don't sum to get_traffic_summary's total for the same period. The period is limited to ${MAX_TREND_DAYS} days. ${SEGMENT_HINT}`,
      inputSchema: { ...period, ...segmentInput },
    },
    async ({ from, to, segment }) => {
      const tooLong = trendLengthError(from, to, "get_traffic_by_day");
      if (tooLong) return tooLong;
      return withSegment(db, segment, { from, to }, (clause) =>
        jsonContent(
          getTrafficByDay(
            db,
            { from, to },
            pageViewEventType,
            timezone,
            clause,
          ),
        ),
      );
    },
  );

  server.registerTool(
    "get_traffic_by_day_of_week",
    {
      description: `Get traffic (${TRAFFIC_FIELDS}) broken down by day of the week (Monday-Sunday) for a given time period — always all 7 days, zero-filled, to see which days get the most traffic. Counts are summed across every occurrence of that weekday in the period (e.g. every Monday), not per-week. Day-of-week is in the site's time zone (${timezone}), not the visitor's local day or UTC. Sessions and visitors are counted per weekday, so a session spanning midnight is counted on both days and these do not sum to get_traffic_summary's total. ${SEGMENT_HINT}`,
      inputSchema: { ...period, ...segmentInput },
    },
    async ({ from, to, segment }) => {
      return withSegment(db, segment, { from, to }, (clause) =>
        jsonContent(
          getTrafficByDayOfWeek(
            db,
            { from, to },
            pageViewEventType,
            timezone,
            clause,
          ),
        ),
      );
    },
  );

  server.registerTool(
    "get_traffic_by_hour",
    {
      description: `Get traffic (${TRAFFIC_FIELDS}) broken down by hour of the day (0-23) for a given time period — always all 24 hours, zero-filled, to see when traffic peaks. Hours are in the site's time zone (${timezone}), not the visitor's local hour or UTC. Where clocks change, the night they go back puts two real hours into hour 2 and the night they go forward leaves hour 2 empty; over a long period this is noise, but over a few days around a change it is not a real peak or gap. Sessions and visitors are counted per hour, so a session spanning two hours is counted in both and these do not sum to get_traffic_summary's total. ${SEGMENT_HINT}`,
      inputSchema: { ...period, ...segmentInput },
    },
    async ({ from, to, segment }) => {
      return withSegment(db, segment, { from, to }, (clause) =>
        jsonContent(
          getTrafficByHour(
            db,
            { from, to },
            pageViewEventType,
            timezone,
            clause,
          ),
        ),
      );
    },
  );

  server.registerTool(
    "get_session_summary",
    {
      description: `Get the shape of the sessions that STARTED in a given time period, each read over its full length even where it ran past the period's end: sessions (how many started), averageSeconds (first event to last, averaged; a single-event session is 0 seconds, not excluded), sessionsWithViews (how many viewed at least one page), bounced (how many of those viewed exactly one page, whatever else they did — a one-view session that downloaded a file still bounced) and bounceRate (bounced / sessionsWithViews, 0-1). This is the site-wide bounce rate; get_top_bounce_pages gives it per entry page, and its top rows do not sum to this. The session count here is lower than get_traffic_summary's for the same period, which counts every session active in it. ${SEGMENT_HINT}`,
      inputSchema: { ...period, ...segmentInput },
    },
    async ({ from, to, segment }) => {
      return withSegment(db, segment, { from, to }, (clause) =>
        jsonContent(
          getSessionSummary(db, { from, to }, pageViewEventType, clause),
        ),
      );
    },
  );

  server.registerTool(
    "get_traffic_change",
    {
      description: `Did traffic really change, or is it noise? Compares a period with the same span 1 to ${BASELINE_PERIODS} weeks earlier (whole weeks, so the weekday mix always matches; a period over 7 days steps back by whole multiples of a week) and gives each number a verdict. Use this before reporting any rise or drop as news; get_traffic_summary twice and a percentage cannot tell 4 → 6 from 40 → 60. Judges sessions and viewEvents (page views), plus one event's count if \`event\` is given. Visitors are left out on purpose: consentless visitor ids rotate daily, so a shift in consent moves them with no change in traffic. Per metric: current, baselineMean, usualLow-usualHigh (the band counted as normal), change, changePct (null when the baseline is zero) and verdict. Verdicts: within_usual_range; above_usual_range or below_usual_range (more than twice the noise away from the baseline mean, where noise is the larger of sqrt(mean) and the baseline weeks' own spread); too_few_to_tell (under 10 on both sides — report no percentage then); too_little_history (fewer than 3 baseline weeks fall inside the stored data, e.g. a new deployment, a recently added event, or rows deleted by retention). A period running past now is cut at now, and each baseline at the same local clock time, so "today so far" is fair. baselinePeriods lists every week compared, so you can show the human the numbers. Limits: above_usual_range means bigger than this site's usual variation, not that a cause was found — read the deployment context's history, and run get_top_referrers or get_top_pages on both periods to see where it came from. Anyone who can reach the collection endpoint can send events, so a verdict can be manufactured; a rise that comes from one referrer or a handful of pages deserves that check. A segment on a recently added event compares against weeks it could not have happened in. The period is limited to ${MAX_CHANGE_DAYS} days. ${SEGMENT_HINT}`,
      inputSchema: {
        ...period,
        event: z
          .string()
          .optional()
          .describe(
            "Optional. A registered event name whose count is also judged, e.g. a signup or purchase event. See list_event_types.",
          ),
        ...segmentInput,
      },
    },
    async ({ from, to, event, segment }) => {
      // Local days, as the step is counted: in UTC milliseconds a month
      // with the autumn clock change measures one day too long.
      const days = enumerateDays(from, to, timezone).length;
      if (days > MAX_CHANGE_DAYS) {
        return toolError(
          `That period covers ${days} days; get_traffic_change compares at most ${MAX_CHANGE_DAYS}. For longer trends use get_traffic_by_day.`,
        );
      }
      const now = new Date();
      if (Date.parse(from) > now.getTime()) {
        return toolError(
          `The period starts in the future (${from}); there is nothing to compare yet.`,
        );
      }
      if (event !== undefined && !isRegisteredEvent(event)) {
        return unknownEventError(event);
      }
      // Resolved once against the period asked for, so a bad segment is
      // an error before any query runs. Each baseline resolves its own,
      // because entry-based conditions depend on the period.
      return withSegment(db, segment, { from, to }, () =>
        jsonContent(
          getTrafficChange(
            db,
            { from, to },
            now,
            timezone,
            pageViewEventType,
            event,
            (p) => {
              const resolved = resolveSegment(db, segment, p);
              if ("error" in resolved) {
                throw new Error("segment resolved once but not again");
              }
              return resolved.clause;
            },
          ),
        ),
      );
    },
  );
};
