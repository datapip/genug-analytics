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
  periodInput,
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
};
