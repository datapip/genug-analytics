import {
  getDeviceTypeBreakdown,
  getBrowserBreakdown,
  getNewVsReturningVisitors,
  getTopLanguages,
  getConsentBreakdown,
  getCohortReturn,
} from "../lib/audience.js";
import {
  periodInput,
  periodBound,
  segmentInput,
  resolveSegment,
  invertedPeriodError,
  limitInput,
  jsonContent,
  toolError,
  rankedShape,
  SEGMENT_HINT,
  type ToolRegistrar,
  VISITOR_TEXT_CAVEAT,
} from "./shared.js";

// "Who is visiting" — the visitor-shaped questions, as opposed to
// traffic volume (traffic.ts) or what they looked at (content.ts).
export const registerAudienceTools: ToolRegistrar = (server, db) => {
  server.registerTool(
    "get_device_breakdown",
    {
      description:
        'Get traffic split by device type (mobile/tablet/desktop/other) and, separately, by browser (Chrome/Safari/Firefox/Edge/Other) for a given time period, as { deviceTypes, browsers } — two rankings, not one crossed table, so "is my traffic mobile" and "do I still need to test Safari" each read off one list. Counted in SESSIONS, not events: a session happens in one browser on one device, and counting events instead would let one visitor who reads twenty pages outweigh ten who read two — making "most of my traffic is desktop" mean only that desktop visitors click around more. Do not compare these against event or page-view counts; they are different units. deviceType is "other" for anything that isn\'t clearly one of the three (e.g. a smart TV or game console), not silently counted as desktop; both are "other"/"Other" when the request carried no User-Agent. For browser on a given device, combine with a segment, e.g. [{"deviceType": "mobile"}]. Each of the two is ranked: ' +
        rankedShape("sessions") +
        " " +
        SEGMENT_HINT,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of rows in each of the two rankings"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent({
        deviceTypes: getDeviceTypeBreakdown(
          db,
          { from, to },
          limit,
          resolved.clause,
        ),
        browsers: getBrowserBreakdown(db, { from, to }, limit, resolved.clause),
      });
    },
  );

  server.registerTool(
    "get_new_vs_returning_visitors",
    {
      description:
        'Get how many distinct visitors active in a given time period are new (their earliest-ever event falls within this period) vs returning (they were already active before it). Important caveat: consentless visitors (see the "consent" envelope field) get a new visitor_id every day by design (daily rotating hash, not a persistent id) — for a mostly-consentless deployment, a visitor returning on a later day looks "new" again here every time, so treat this as a soft signal rather than a precise retention number. It is meaningful for consentful visitors (a persistent cookie id) and for same-day returns either way. Call get_consent_breakdown to find out which case this deployment is actually in. "Earliest-ever" means the oldest event still stored: where a retention limit prunes old rows (see the cockpit), a visitor whose earlier visits were pruned looks new again. For "did the visitors from one period come back in another" use get_cohort_return.',
      inputSchema: periodInput,
    },
    async ({ from, to }) => {
      return jsonContent(getNewVsReturningVisitors(db, { from, to }));
    },
  );

  server.registerTool(
    "get_cohort_return",
    {
      description:
        'Get whether the visitors of one period came back in a later one: cohortVisitors (distinct visitors active in the cohort period — narrowed by `segment`, e.g. those who entered via utm_campaign=spring), returnedVisitors (how many of them have at least one event in the return period), returnRate (returned / cohort, 0-1) and consentfulVisitors. Read consentfulVisitors before the rate: a consentless visitor_id is a new hash every UTC day by design, so a cohort visitor who stays consentless can never be recognised on a later day, and a return rate over a mostly-consentless cohort is really a consent rate. consentfulVisitors is a floor on who could be followed, not a ceiling on returnedVisitors: a visitor who was consentless in the cohort and accepted the banner on a later visit keeps the id they had that day, so they can appear as returned without counting as consentful. Say it plainly: "of the N visitors identifiable in the cohort, M came back; the other K were consentless and cannot be followed across days unless they consented later". The return period must start after the cohort period ends. The segment\'s entry-based conditions (referrerHost, entryPath, entryParam) look at sessions that started in the cohort period.',
      inputSchema: {
        cohortFrom: periodBound(
          "from",
          "Start of the cohort period, inclusive (ISO8601 date or timestamp) — the visitors active in this period, narrowed by segment, are the cohort.",
        ),
        cohortTo: periodBound(
          "to",
          "End of the cohort period, inclusive (ISO8601 date or timestamp).",
        ),
        returnFrom: periodBound(
          "from",
          "Start of the return period, inclusive; must be after cohortTo.",
        ),
        returnTo: periodBound(
          "to",
          "End of the return period, inclusive (ISO8601 date or timestamp).",
        ),
        ...segmentInput,
      },
    },
    async ({ cohortFrom, cohortTo, returnFrom, returnTo, segment }) => {
      // Neither pair is named from/to, so the registration-time guard
      // (mcp/tools.ts) doesn't see them; checked here instead, plus the
      // ordering between the two periods that no single-period tool has.
      const inverted =
        invertedPeriodError(cohortFrom, cohortTo) ??
        invertedPeriodError(returnFrom, returnTo);
      if (inverted) return inverted;
      if (returnFrom <= cohortTo) {
        return toolError(
          `The return period (from ${returnFrom}) must start after the cohort period ends (${cohortTo}); otherwise a cohort visitor "returns" by merely being in the cohort.`,
        );
      }
      const resolved = resolveSegment(db, segment, {
        from: cohortFrom,
        to: cohortTo,
      });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getCohortReturn(
          db,
          { from: cohortFrom, to: cohortTo },
          { from: returnFrom, to: returnTo },
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_top_languages",
    {
      description:
        'Get the languages/locales visitors browse in for a given time period, ranked by sessions descending — the visitor\'s own browser or device locale (e.g. "en-US", "de"), taken from the Accept-Language header. Counted in SESSIONS, the same unit as get_device_breakdown, so the two can be read side by side; not visitors, whose consentless ids rotate daily and would count one regular reader once per day. A language of null means the request carried no Accept-Language header at all, so the locale is genuinely unknown. Note this is the visitor\'s preference, not the language of the page they viewed — an event may separately declare a document_language prop for that. ' +
        rankedShape("sessions") +
        " " +
        SEGMENT_HINT +
        " " +
        VISITOR_TEXT_CAVEAT,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of languages to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getTopLanguages(db, { from, to }, limit, resolved.clause),
      );
    },
  );

  server.registerTool(
    "get_consent_breakdown",
    {
      description:
        "Get how much of the data collected in a period was recorded with the visitor's consent: event and distinct-visitor counts for consentful (a persistent cookie id was used) versus consentless (a cookieless, daily-rotating hash). Use this to interpret get_new_vs_returning_visitors and get_cohort_return, whose accuracy depends entirely on this mix — a mostly-consentless deployment can't reliably tell a returning visitor from a new one across days. Event counts are exact; a visitor who accepts a consent banner mid-period legitimately appears under both modes, so the two visitor counts can sum to more than the true total.",
      inputSchema: periodInput,
    },
    async ({ from, to }) => {
      return jsonContent(getConsentBreakdown(db, { from, to }));
    },
  );
};
