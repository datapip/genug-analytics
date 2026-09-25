import { z } from "zod";
import { pageViewEventType } from "@genug/schema-registry";
import {
  getTopPages,
  getTopReferrers,
  getTopEntryParams,
  getEntryPages,
  getExitPages,
  getBouncePages,
} from "../lib/content.js";
import { isKeptQueryParam, describeKeptQueryParams } from "../lib/url.js";
import {
  periodInput,
  segmentInput,
  resolveSegment,
  limitInput,
  jsonContent,
  toolError,
  rankedShape,
  SEGMENT_HINT,
  type ToolRegistrar,
  VISITOR_TEXT_CAVEAT,
} from "./shared.js";

// "Which pages, and where from" — every tool here ranks the page-view
// event, which the schema registry guarantees exists (exactly one
// registered event carries the pageView tag), so none of them has an
// "unavailable here" case to report.
export const registerContentTools: ToolRegistrar = (server, db) => {
  server.registerTool(
    "get_top_pages",
    {
      description: `Get the most-visited pages for a given time period, ranked by views (page-view events) descending. Pages are grouped by path: query string and fragment are dropped, and so is the host, so a deployment serving several domains sees the same path on each merged into one row. ${rankedShape("views")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of pages to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getTopPages(
          db,
          { from, to },
          limit,
          pageViewEventType,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_top_entry_pages",
    {
      description: `Get the pages visitors most often land on first, ranked by number of sessions that started there, descending. Counts sessions that STARTED in the period, by their first page view — a session already under way when the period began belongs to the earlier period and is not counted here, so these totals can be lower than get_traffic_summary's session count for the same period, which counts every session active in it. Different from get_top_pages, which counts every view regardless of position in the session. ${rankedShape("sessions")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of pages to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getEntryPages(
          db,
          { from, to },
          limit,
          pageViewEventType,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_top_exit_pages",
    {
      description: `Get the pages visitors most often leave the site from, ranked by number of sessions that ended there, descending. Counts sessions that STARTED in the period and reports each one's genuine last page view, even where it fell after the period's end — so a session that began late in the period is attributed to its real exit page, not to whatever it happened to be viewing at the cutoff. A high count here isn't necessarily bad — it can mean a natural end point (e.g. a checkout confirmation page) or a place people give up. ${rankedShape("sessions")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of pages to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getExitPages(
          db,
          { from, to },
          limit,
          pageViewEventType,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_top_bounce_pages",
    {
      description: `Get the entry pages that lose the most visitors: of the sessions that entered on each page, how many viewed no other page ("bounced"), ranked by that bounced count descending — not by rate, which would put a page with one session and one bounce above one with 500 sessions and 400 bounces. Each row also carries the entry sessions and the bounce rate (0-1) for reading. Only sessions that STARTED in the period count, and each is judged on its full length, so a session that read three pages before the period began is never mistaken for a bounce. A bounce is one page view, whatever else happened: a one-view session that downloaded a file still bounced. For the site-wide bounce rate use get_session_summary. ${rankedShape("bounced sessions")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of pages to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getBouncePages(
          db,
          { from, to },
          limit,
          pageViewEventType,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_top_referrers",
    {
      description: `Get the top traffic sources for a given time period, ranked descending, grouped by the referring domain (e.g. "www.google.com", "x.com"). Counted in SESSIONS, not page views: each visit is attributed once, to the referrer of the page view that started it, however many pages it went on to read. Do not compare these numbers against page-view counts from get_top_pages or get_traffic_summary — they are different units and will not add up. A host of null means direct traffic: the visitor arrived with no referrer at all (typed the URL, used a bookmark, or came from a source that strips referrer information). Self-referrals are excluded, so the deployment's own domain never appears and the totals can be lower than the period's session count. Only sessions that STARTED in the period are attributed; a session already under way when it began belongs to the earlier period and is left out, so on a short period the total here is below get_traffic_summary's session count and that gap is worth mentioning rather than reporting the split as complete. For campaign-tagged links (utm_source and friends) use get_top_entry_params. ${rankedShape("sessions")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of referrer hosts to return"),
      },
    },
    async ({ from, to, segment, limit }) => {
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getTopReferrers(
          db,
          { from, to },
          limit,
          pageViewEventType,
          resolved.clause,
        ),
      );
    },
  );

  server.registerTool(
    "get_top_entry_params",
    {
      description: `Get sessions ranked by the value of one query parameter on the page they entered on — the read side of campaign-tagged links: utm_campaign, utm_source, utm_medium and the like, or an ad click id. Counted in SESSIONS that STARTED in the period, each attributed once to its entry page's value. Only the parameters kept when a URL is stored can be asked for (${describeKeptQueryParams()}); anything else is stripped at ingestion for privacy and the tool says so. The deployment chooses that list, so a parameter it started keeping recently has no values on sessions stored before the change — a short history there is not low traffic. Sessions whose entry page carried no such parameter are not a row, so groups and total describe tagged sessions only — compare total against get_traffic_summary's sessions to see how much traffic is tagged at all. No attribution model is applied: this reads one parameter as stored, and combining several (source + medium) is two calls. ${rankedShape("sessions")} ${SEGMENT_HINT} ${VISITOR_TEXT_CAVEAT}`,
      inputSchema: {
        param: z
          .string()
          .describe(
            `The query parameter to rank by, e.g. "utm_campaign". One of: ${describeKeptQueryParams()}.`,
          ),
        ...periodInput,
        ...segmentInput,
        limit: limitInput("Max number of distinct values to return"),
      },
    },
    async ({ param, from, to, segment, limit }) => {
      if (!isKeptQueryParam(param)) {
        return toolError(
          `Query parameter "${param}" is not kept when a URL is stored, so nothing can match it. Parameters that are kept: ${describeKeptQueryParams()}.`,
        );
      }
      const resolved = resolveSegment(db, segment, { from, to });
      if ("error" in resolved) return resolved.error;
      return jsonContent(
        getTopEntryParams(
          db,
          param,
          { from, to },
          limit,
          pageViewEventType,
          resolved.clause,
        ),
      );
    },
  );
};
