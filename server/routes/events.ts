import {
  Router,
  json,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z, type ZodError } from "zod";
import {
  envelopeSchema,
  eventRegistry,
  type Envelope,
  roleEventNames,
  MAX_EVENT_NAME_LENGTH,
  MAX_URL_LENGTH,
} from "@genug/schema-registry";
import type Database from "better-sqlite3";
import { insertEvent, findLastEventForVisitor } from "../db/events.js";
import {
  insertRejectedEvent,
  type RejectionReason,
} from "../db/rejectedEvents.js";
import { resolveVisitorIdentity } from "../lib/identity.js";
import { truncateIp } from "../lib/ip.js";
import { resolveSessionId } from "../lib/session.js";
import { isBotUserAgent } from "../lib/bots.js";
import { classifyUserAgent } from "../lib/userAgent.js";
import { siteHost, stripUnknownParams } from "../lib/url.js";
import { recordBotHit, botActivityCounter } from "../lib/botActivity.js";
import { parseCookies } from "../lib/cookies.js";
import type { DailySalt } from "../lib/dailySalt.js";
import type { CountryTable } from "../lib/country.js";
import type { DiskGuard } from "../lib/diskSpace.js";

const VISITOR_ID_COOKIE = "genug_vid";
// 13 months: the longest life the French regulator CNIL accepts for an
// analytics identifier. Chrome would allow 400 days, but 13 months is
// the safer choice in the EU. Counted from the last explicit consent,
// since only that sets the cookie again (lib/identity.ts).
const VISITOR_ID_COOKIE_MAX_AGE_MS = 396 * 24 * 60 * 60 * 1000;
// The same options for setting and for clearing the cookie: the browser
// only deletes it if the options match the ones it was set with.
const VISITOR_ID_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
} as const;

// How each role is written in an event file, so the rejection message
// can say exactly which key to add.
const AUTO_ROLE_TAG_KEYS: Record<string, string> = {
  pageView: "pageView",
  outboundClick: "automaticOutboundClick",
  fileDownload: "automaticFileDownload",
};

// The prop in which each automatic link event sends the clicked URL.
// The client script decides these names, not the event file.
const ROLE_URL_PROPS: Record<string, string> = {
  outboundClick: "target_url",
  fileDownload: "file_url",
};

// Returns a plain boolean, not a type predicate: event names come from
// JSON files, so the type is just `string`. Uses hasOwnProperty rather
// than `in`, because `in` also matches built-in object keys such as
// "constructor" and "toString", which aren't events.
function isKnownEventType(event: string): boolean {
  return Object.prototype.hasOwnProperty.call(eventRegistry, event);
}

// A short "path: message" summary of the first validation problem, such
// as "props.value: Expected number, received string", so a rejection
// says why (see get_top_rejected_events). Only the first problem: it is
// a hint, not a full report.
// Length-limited, because the message can contain the sender's input
// (an unknown key's name, for example), and get_top_rejected_events
// shows it to the agent as it is.
const MAX_DETAIL_LENGTH = 200;

function firstIssueDetail(error: ZodError): string {
  const issue = error.issues[0]!;
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`.slice(0, MAX_DETAIL_LENGTH);
}

// Only a language tag is stored (BCP 47: "en", "en-US", "zh-Hant-TW").
// The header is text the visitor's browser sends, and get_top_languages
// shows it to the agent, so anything else is treated as if there were
// no header.
const LOCALE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function parsePrimaryLanguage(
  acceptLanguage: string | undefined,
): string | undefined {
  const token = acceptLanguage?.split(",")[0]?.split(";")[0]?.trim();
  return token && LOCALE_TAG.test(token) ? token : undefined;
}

// Only the listed origins are allowed, never "*" or any origin that
// asks. The response names the origin that asked, because with several
// allowed origins the header must name the one making the request. That
// is also why `Vary: Origin` below is needed: caches must keep one
// answer per origin.
function cors(
  allowedOrigins: ReadonlySet<string>,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const origin = req.headers.origin;
  if (origin !== undefined && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    // Requests carry cookies (sendBeacon always does; the fetch fallback
    // uses credentials: "include"), and the browser requires this header
    // for that.
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Every event is a cross-origin POST with JSON, so the browser first
    // sends a preflight request. Without this header it remembers the
    // preflight for only about five seconds, so most events would need
    // two requests. Browsers cap the value (Chrome at 2 hours, Firefox at
    // 24), so this asks for the most any of them allows.
    res.setHeader("Access-Control-Max-Age", "86400");
    res.sendStatus(204);
    return;
  }
  next();
}

// What the route needs from the server. The daily salt is replaced by
// its owner (startRotation); this router only reads it.
export interface EventsRouterDeps {
  db: Database.Database;
  allowedOrigins: ReadonlySet<string>;
  // The sites of those origins (siteHost, lib/url.ts). An event's url
  // must be on one of them: the sender writes the url, and its host
  // decides the visitor, the session and the host segment's sites.
  siteHosts: ReadonlySet<string>;
  dailySalt: DailySalt;
  // Stops storing a little before the volume is full (lib/diskSpace.ts).
  diskGuard: DiskGuard;
  // Absent unless COUNTRY_LOOKUP=true; the column then stays NULL.
  countries?: CountryTable;
}

// The largest request body accepted. The envelope limits its own fields
// (schema-registry/envelope.ts); this mainly limits `props`. 16KB leaves
// room for a 2KB url, a 2KB referrer and plenty of props. Anything
// bigger is a mistake or an attack and gets a 413.
const parseBody = json({ limit: "16kb" });

// Strict on purpose: exactly this one key, with the value `true`. A body
// that also has an event name is an event, not an opt-out.
const optOutSchema = z.strictObject({ optOut: z.literal(true) });

// Records a refused event in rejected_events, so the cockpit and
// get_top_rejected_events can show why, and answers 400.
interface Rejection {
  reason: RejectionReason;
  event?: string;
  detail?: string;
  error: string;
}

type Checked<T> = { ok: true; value: T } | { ok: false; rejection: Rejection };

// An event that passed every check, ready to be stored.
interface ValidEvent {
  envelope: Envelope;
  name: string;
  url: string;
  referrer: string | undefined;
  props: Record<string, unknown>;
}

// POST /events: the public route every tracked page sends events to, with
// no sign-in. It sits behind the per-address rate limit (app.ts).
export function createEventsRouter(deps: EventsRouterDeps): Router {
  const router = Router();
  router.use((req, res, next) => cors(deps.allowedOrigins, req, res, next));
  router.post("/", parseBody, (req, res) => receiveEvent(deps, req, res));
  return router;
}

function receiveEvent(
  deps: EventsRouterDeps,
  req: Request,
  res: Response,
): void {
  // Read the clock once and use the same time everywhere below.
  const now = new Date();

  // Bots are dropped with the same 204 a real event gets, so a real
  // visitor mistaken for a bot never sees an error. See lib/bots.ts.
  if (isBotUserAgent(req.headers["user-agent"])) {
    recordBotHit(botActivityCounter);
    res.status(204).end();
    return;
  }

  // An opt-out is not an event and is never stored. It exists so the
  // visitor cookie can be deleted: the cookie is httpOnly, so the site's
  // JavaScript can't delete it, only a response from here. The client
  // sets its own opt-out cookie and then sends nothing more.
  //
  // Checked before the envelope, because an opt-out has no event name or
  // role and would otherwise be rejected.
  if (optOutSchema.safeParse(req.body).success) {
    if (parseCookies(req.headers.cookie)[VISITOR_ID_COOKIE]) {
      res.clearCookie(VISITOR_ID_COOKIE, VISITOR_ID_COOKIE_OPTIONS);
    }
    res.status(204).end();
    return;
  }

  // After the opt-out, which writes nothing and must still clear the
  // cookie; before the envelope, because a rejected event is written too.
  // A 503 rather than a quiet 204: the event is lost, and the browser's
  // network panel should show it.
  if (!deps.diskGuard.hasRoom(now.getTime())) {
    res.set("Retry-After", "60");
    res.status(503).json({ error: "server disk is full" });
    return;
  }

  const checked = checkEvent(req.body, deps.siteHosts);
  if (!checked.ok) {
    const { reason, event, detail, error } = checked.rejection;
    insertRejectedEvent(deps.db, reason, now.toISOString(), event, detail);
    res.status(400).json({ error });
    return;
  }

  storeEvent(deps, req, res, checked.value, now);

  // A duplicate gets the same 204 as a stored event, so a reloaded
  // confirmation page never sees an error.
  res.status(204).end();
}

// Every check an event goes through before it is stored, in order. Each
// step that refuses gives the reason the cockpit counts it under.
function checkEvent(
  body: unknown,
  siteHosts: ReadonlySet<string>,
): Checked<ValidEvent> {
  const parsed = parseEnvelope(body);
  if (!parsed.ok) return parsed;
  const { envelope, url, referrer } = parsed.value;

  // A browser only gets here from a page on an allowed origin (because
  // of CORS), and the script sends that page's address, so real events
  // always pass. This refuses hand-made requests that would add a fake
  // site, such as a lookalike host, to what the agent sees.
  if (!siteHosts.has(siteHost(url))) {
    return reject({
      reason: "invalid_envelope",
      event: envelope.event,
      detail: "url is not on a site ALLOWED_ORIGIN lists",
      error: "invalid envelope",
    });
  }

  const name = resolveEventName(envelope);
  if (!name.ok) return name;

  const props = validateProps(name.value, normaliseProps(name.value, envelope));
  if (!props.ok) return props;

  return {
    ok: true,
    value: { envelope, name: name.value, url, referrer, props: props.value },
  };
}

function parseEnvelope(
  body: unknown,
): Checked<{ envelope: Envelope; url: string; referrer: string | undefined }> {
  const result = envelopeSchema.safeParse(body);
  if (!result.success) {
    // The body failed validation, so the event name may be missing or
    // wrong.
    const maybeEvent =
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>).event === "string"
        ? // Cut to the same length envelopeSchema allows, because the
          // name hasn't been checked and is stored with the rejection.
          (body as { event: string }).event.slice(0, MAX_EVENT_NAME_LENGTH)
        : undefined;
    return reject({
      reason: "invalid_envelope",
      event: maybeEvent,
      detail: firstIssueDetail(result.error),
      error: "invalid envelope",
    });
  }
  const envelope = result.data;

  // Remove unwanted URL parts here as well as in the client: /events is
  // public, so a request may not come from the client script. See
  // lib/url.ts.
  //
  // The envelope already limited the length, but cleaning the URL can
  // make it longer (it percent-encodes characters, so 2,000 "(" become
  // three times as long). So the length is checked again.
  const url = stripUnknownParams(envelope.url);
  const referrer =
    envelope.referrer === undefined
      ? undefined
      : stripUnknownParams(envelope.referrer);
  if (url.length > MAX_URL_LENGTH || (referrer?.length ?? 0) > MAX_URL_LENGTH) {
    return reject({
      reason: "invalid_envelope",
      event: envelope.event,
      detail: `url or referrer is over ${MAX_URL_LENGTH} characters once re-encoded`,
      error: "invalid envelope",
    });
  }
  return { ok: true, value: { envelope, url, referrer } };
}

// For the three events the client script sends by itself, it sends a
// role instead of a name, because it doesn't know what this deployment
// calls them. The name is looked up here, on every request, so an old
// cached script can never send a name that no longer exists.
//
// An event name is lowercased before lookup. All registered names are
// lowercase (isValidEventName), so a track() call with different
// casing still finds the event it meant.
function resolveEventName(envelope: Envelope): Checked<string> {
  const name =
    envelope.event?.toLowerCase() ??
    (envelope.auto === undefined ? undefined : roleEventNames[envelope.auto]);
  if (name !== undefined && isKnownEventType(name)) {
    return { ok: true, value: name };
  }
  // A role no event has is rejected under the role's name, with the tag
  // to add as the detail. It counts like a mistyped event name, so there
  // is one place to look when something isn't recorded.
  if (name === undefined) {
    return reject({
      reason: "unknown_event_type",
      event: envelope.auto,
      detail: `no registered event carries "_${AUTO_ROLE_TAG_KEYS[envelope.auto!]}": true`,
      error: `no event is registered for automatic ${envelope.auto} tracking`,
    });
  }
  return reject({
    reason: "unknown_event_type",
    event: name,
    error: `unknown event type: ${name}`,
  });
}

function normaliseProps(
  eventName: string,
  envelope: Envelope,
): Record<string, unknown> {
  // Prop names are lowercased too, for the same reason: all declared prop
  // names are lowercase, so a key with different casing still matches
  // instead of being rejected as unknown.
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.props)) {
    props[key.toLowerCase()] = value;
  }

  // A clicked link can contain ?email= or tokens just like a page URL, so
  // it is cleaned the same way. The client does this too; this is the
  // safety net, as for `url`. Based on the event, not on how it was sent,
  // so a track() call for the same event is cleaned too. Only these two
  // events, because only there does the client script decide the prop
  // name.
  for (const [role, prop] of Object.entries(ROLE_URL_PROPS)) {
    const linkUrl = props[prop];
    if (
      roleEventNames[role as keyof typeof roleEventNames] === eventName &&
      typeof linkUrl === "string"
    ) {
      props[prop] = stripUnknownParams(linkUrl);
    }
  }
  return props;
}

function validateProps(
  eventName: string,
  props: Record<string, unknown>,
): Checked<Record<string, unknown>> {
  const result = eventRegistry[eventName].schema.safeParse(props);
  if (!result.success) {
    return reject({
      reason: "invalid_props",
      event: eventName,
      detail: firstIssueDetail(result.error),
      error: "invalid props for event type",
    });
  }
  return { ok: true, value: result.data };
}

function reject(rejection: Rejection): { ok: false; rejection: Rejection } {
  return { ok: false, rejection };
}

// Works out the visitor and session and builds the row. Also sets or
// clears the visitor cookie, which is why it takes the response.
function storeEvent(
  { db, dailySalt, countries }: EventsRouterDeps,
  req: Request,
  res: Response,
  event: ValidEvent,
  now: Date,
): void {
  // Shortened to a block before hashing or the country lookup (see
  // lib/ip.ts). The rate limiter shortens differently: it keeps a full
  // IPv4 address, to tell one abuser from the office around them.
  const ip = truncateIp(req.ip ?? "");
  const country = countries?.lookup(ip);
  const userAgent = req.headers["user-agent"];
  // The User-Agent itself isn't stored: it is used for the bot check and
  // the hash below, and only its category is saved.
  const device =
    userAgent === undefined ? undefined : classifyUserAgent(userAgent);
  const visitorLanguage = parsePrimaryLanguage(req.headers["accept-language"]);
  // Which of the installation's sites this event is from, for the
  // visitor hash and the session (lib/url.ts).
  const site = siteHost(event.url);

  // Who sent this request, and what to do with their cookie.
  // lib/identity.ts decides; this route sets or clears the cookie, since
  // it knows the cookie's name and lifetime.
  const { visitorId, consentful, cookie } = resolveVisitorIdentity({
    consent: event.envelope.consent,
    visitorCookie: parseCookies(req.headers.cookie)[VISITOR_ID_COOKIE],
    site,
    ip,
    userAgent,
    salt: dailySalt.saltFor(now),
  });

  if (cookie === "set") {
    res.cookie(VISITOR_ID_COOKIE, visitorId, {
      ...VISITOR_ID_COOKIE_OPTIONS,
      maxAge: VISITOR_ID_COOKIE_MAX_AGE_MS,
    });
  } else if (cookie === "clear") {
    res.clearCookie(VISITOR_ID_COOKIE, VISITOR_ID_COOKIE_OPTIONS);
  }

  const lastEvent = findLastEventForVisitor(db, visitorId);
  const sessionId = resolveSessionId(lastEvent, now, site);

  insertEvent(db, {
    event: event.name,
    visitorId,
    sessionId,
    ts: now.toISOString(),
    url: event.url,
    referrer: event.referrer,
    deviceType: device?.deviceType,
    browser: device?.browser,
    visitorLanguage,
    country,
    props: event.props,
    idempotencyKey: event.envelope.idempotencyKey,
    consentMode: consentful ? "consentful" : "consentless",
  });
}
