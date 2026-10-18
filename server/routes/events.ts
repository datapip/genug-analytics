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
import { stripUnknownParams } from "../lib/url.js";
import { recordBotHit, botActivityCounter } from "../lib/botActivity.js";
import { parseCookies } from "../lib/cookies.js";
import type { DailySalt } from "../lib/dailySalt.js";
import type { DiskGuard } from "../lib/diskSpace.js";

const VISITOR_ID_COOKIE = "genug_vid";
// 13 months — the ceiling CNIL treats as the maximum life for an
// analytics identifier. Chrome would allow 400 days; the shorter one is
// what's defensible for the EU deployments this is built for. Counted
// from the last explicit consent, since only that sets it again
// (lib/identity.ts).
const VISITOR_ID_COOKIE_MAX_AGE_MS = 396 * 24 * 60 * 60 * 1000;
// One object for setting and for clearing: a clear only removes the
// cookie the browser actually holds if its attributes match the ones it
// was set with, so these must not be allowed to drift apart.
const VISITOR_ID_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
} as const;

// How each role is written in an event file, so a deployment reading the
// rejection knows exactly which key to add. Kept here rather than
// exported from the registry: it exists only to word this one message.
const AUTO_ROLE_TAG_KEYS: Record<string, string> = {
  pageView: "pageView",
  outboundClick: "automaticOutboundClick",
  fileDownload: "automaticFileDownload",
};

// The prop each automatic link event puts the clicked URL in. Fixed by
// the client script, not by the event file, which is why it can live here.
const ROLE_URL_PROPS: Record<string, string> = {
  outboundClick: "target_url",
  fileDownload: "file_url",
};

// Plain boolean, not a type predicate: event names come from JSON files
// read at startup, so `EventType` is `string` and narrowing to it would
// say nothing. The runtime check is the real one either way, and it has
// to be — hasOwnProperty rather than `in`, because `in` also matches
// inherited Object.prototype keys ("constructor", "toString"), which
// would look up a registry entry that isn't an event at all.
function isKnownEventType(event: string): boolean {
  return Object.prototype.hasOwnProperty.call(eventRegistry, event);
}

// A short "path: message" summary of the first failing issue — e.g.
// "props.value: Expected number, received string" — so a rejected
// request leaves behind more than just "this happened N times" (see
// get_top_rejected_events). Only the first issue, not every one: this is
// a diagnostic hint for a human/agent skimming rejection counts, not a
// full validation report.
// Capped, because the message can embed the offending input: a Zod
// `unrecognized_keys` issue names the key, so a 12,000-character prop
// key produced a 12,000-character detail row. That defeats the point of
// the envelope's own length caps, and this value is handed to the AI
// agent verbatim by get_top_rejected_events.
const MAX_DETAIL_LENGTH = 200;

function firstIssueDetail(error: ZodError): string {
  const issue = error.issues[0]!;
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`.slice(0, MAX_DETAIL_LENGTH);
}

// Only a locale-shaped token is stored (BCP 47: "en", "en-US",
// "zh-Hant-TW"). The header is visitor-written text, read back by
// get_top_languages and now also a segment condition; without this it
// was the one envelope field with no cap at all, bounded only by Node's
// header limit, while the raw User-Agent is dropped for exactly the
// singling-out reason. Anything else is treated as no header.
const LOCALE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function parsePrimaryLanguage(
  acceptLanguage: string | undefined,
): string | undefined {
  const token = acceptLanguage?.split(",")[0]?.split(";")[0]?.trim();
  return token && LOCALE_TAG.test(token) ? token : undefined;
}

// Known origins only, never a wildcard/reflect-any-origin policy (see
// Deployment model docs). The requesting origin is echoed back rather
// than a fixed configured value, because with more than one allowed
// origin the header has to name the one actually asking — which is also
// what makes `Vary: Origin` below load-bearing rather than tidiness.
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
    // Requests carry cookies by default (sendBeacon always; the fetch
    // fallback via credentials: "include") — the browser requires this
    // whenever Allow-Origin names a specific origin rather than "*".
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Every event is a cross-origin POST sending application/json, which
    // is not a CORS-safelisted content type — so the browser preflights
    // each one. Without this header it caches that preflight for about
    // five seconds, making a visitor's every event two round trips
    // instead of one. Browsers clamp the value to their own ceiling
    // (Chrome 2 hours, Firefox 24), so this asks for the longest any of
    // them will grant rather than a number picked to mean something.
    res.setHeader("Access-Control-Max-Age", "86400");
    res.sendStatus(204);
    return;
  }
  next();
}

// What the route needs from the server that runs it. The daily salt is
// rotated by whoever made it (startRotation); this router only reads it.
export interface EventsRouterDeps {
  db: Database.Database;
  allowedOrigins: ReadonlySet<string>;
  dailySalt: DailySalt;
  // Stops storing a little before the volume is full (lib/diskSpace.ts).
  diskGuard: DiskGuard;
}

// express.json() defaults to a 100KB body, which is far more than any
// real event needs and enough to make storage abuse cheap. This is the
// bound on `props` specifically: the envelope caps its own fields
// (schema-registry/envelope.ts), but props are open by design, so the
// only sane limit on them is the size of the whole request. 16KB still
// leaves room for a 2KB url, a 2KB referrer and a generous set of
// props; anything past it is a mistake or an attack, and gets a 413
// rather than a row.
const parseBody = json({ limit: "16kb" });

// Deliberately strict: only this one key, only `true`. A body that also
// carries an event name is an event, not an opt-out, and must not be
// able to reach the early return below.
const optOutSchema = z.strictObject({ optOut: z.literal(true) });

// What a refused event leaves behind: a rejected_events row, so the
// cockpit and get_top_rejected_events can say why, and the 400 the
// sender sees.
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

// POST /events, the public, unauthenticated route every tracked page
// sends to. Mounted behind the per-address rate limit (app.ts).
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
  // Stamped once, up front, and reused everywhere below (a rejected
  // request's ts, a real event's ts, the daily salt): one reading of the
  // clock per request, not a slightly different one at each call site.
  const now = new Date();

  // Dropped silently — same 204 a real event gets — rather than erroring,
  // so a false positive here never surfaces a client-visible error. See
  // lib/bots.ts for what "bot" means here (best-effort, not adversarial).
  if (isBotUserAgent(req.headers["user-agent"])) {
    recordBotHit(botActivityCounter);
    res.status(204).end();
    return;
  }

  // An opt-out is not an event and never becomes a row. It exists only
  // so the identifier can actually leave the device: the cookie is
  // httpOnly, so the tracked site's own JavaScript cannot delete it and
  // only a response from here can. The client sets its own opt-out
  // cookie and then goes silent, so this is the last request it makes.
  //
  // Checked before the envelope, because an opt-out carries neither an
  // event name nor a role and would be rejected as malformed.
  if (optOutSchema.safeParse(req.body).success) {
    if (parseCookies(req.headers.cookie)[VISITOR_ID_COOKIE]) {
      res.clearCookie(VISITOR_ID_COOKIE, VISITOR_ID_COOKIE_OPTIONS);
    }
    res.status(204).end();
    return;
  }

  // After the opt-out, which writes nothing and must still reach the
  // cookie; before the envelope, because a rejected event is a row too.
  // A 503 rather than the bot path's quiet 204: the event is lost, and
  // a browser's network panel is one more place that says so.
  if (!deps.diskGuard.hasRoom(now.getTime())) {
    res.set("Retry-After", "60");
    res.status(503).json({ error: "server disk is full" });
    return;
  }

  const checked = checkEvent(req.body);
  if (!checked.ok) {
    const { reason, event, detail, error } = checked.rejection;
    insertRejectedEvent(deps.db, reason, now.toISOString(), event, detail);
    res.status(400).json({ error });
    return;
  }

  storeEvent(deps, req, res, checked.value, now);

  // A deduped duplicate still gets the same 204 a real event does — the
  // client can't tell the difference, same as the bot-drop above, so a
  // refreshed confirmation page never sees an error to retry or surface.
  res.status(204).end();
}

// Every check a body goes through before it may become a row, in order.
// Each step refuses with the reason the cockpit then counts it under.
function checkEvent(body: unknown): Checked<ValidEvent> {
  const parsed = parseEnvelope(body);
  if (!parsed.ok) return parsed;
  const { envelope, url, referrer } = parsed.value;

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
    // The body's shape is unknown at this point (that's exactly what
    // just failed), so the event name is best-effort only.
    const maybeEvent =
      typeof body === "object" &&
      body !== null &&
      typeof (body as Record<string, unknown>).event === "string"
        ? // Truncated to the same cap envelopeSchema enforces: the
          // schema rejected this body, so the name never passed that
          // check, and the envelope's comment is explicit that the cap
          // exists precisely because the rejection is what reaches disk.
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

  // Stripped here as well as in the client: /events is public, so a
  // caller that isn't the client script reaches this line with whatever
  // query string it likes. See lib/url.ts.
  //
  // The envelope capped the raw value, but stripping re-serializes the
  // URL, and that percent-encodes what the sender left bare — a query of
  // 2,000 "(" comes out three times as long. Checked again afterwards,
  // since the cap is what bounds the text a stranger can put in front of
  // the agent.
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

// The client script sends a role rather than a name for the three
// events it fires itself, because it does not know what this deployment
// calls them — so the name is decided here, from the registry, on every
// request. A cached copy of the script therefore cannot send a name
// that no longer exists.
//
// A literal `event` is folded to lowercase before it's looked up: every
// registered name is enforced lowercase (isValidEventName), so this only
// ever helps — a track() call with stray-case matches the event it
// plainly meant instead of being rejected as unknown over nothing but
// casing. A role-resolved name is already lowercase from the registry.
function resolveEventName(envelope: Envelope): Checked<string> {
  const name =
    envelope.event?.toLowerCase() ??
    (envelope.auto === undefined ? undefined : roleEventNames[envelope.auto]);
  if (name !== undefined && isKnownEventType(name)) {
    return { ok: true, value: name };
  }
  // An unresolved role is stored under the role it asked for, with the
  // tag to add as the detail. Same reason/counter as a mistyped event
  // name: one place to look when something isn't being recorded.
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
  // Folded the same way the event name is, and for the same reason: every
  // declared prop name is enforced lowercase, so a stray-case key from the
  // client (a typo'd data-genug-props, or a site's own inconsistent casing)
  // matches the prop it plainly meant instead of tripping the schema's
  // strict "unrecognized key" rejection over nothing but casing.
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.props)) {
    props[key.toLowerCase()] = value;
  }

  // The link a visitor clicked carries the same ?email= and tokens a page
  // URL can, so it gets the same allowlist. The client strips it too;
  // this is the backstop, as for `url`. Keyed on the resolved event, not
  // on how it was sent, so a track() call naming the event by hand is
  // filtered the same way and the prop's description stays true. Only
  // these two events: there the client script fixes the prop name, while
  // a deployment's own props are its own to name.
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

// Who sent it, which session it belongs to, and the row itself. Also
// sets or clears the visitor cookie, which is why it takes the response.
function storeEvent(
  { db, dailySalt }: EventsRouterDeps,
  req: Request,
  res: Response,
  event: ValidEvent,
  now: Date,
): void {
  // Narrowed to a block before it is hashed (see lib/ip.ts). The rate
  // limiter narrows differently, and less: it keeps an IPv4 address
  // whole, because it has to tell one abuser from the office around
  // them.
  const ip = truncateIp(req.ip ?? "");
  const userAgent = req.headers["user-agent"];
  // The header itself goes no further than this request: it feeds the
  // bot check and the consentless hash below, and only what it
  // classifies to is stored (see db/migrations.ts).
  const device =
    userAgent === undefined ? undefined : classifyUserAgent(userAgent);
  const visitorLanguage = parsePrimaryLanguage(req.headers["accept-language"]);

  // Who this request belongs to, and what that means for their cookie.
  // The decision is lib/identity.ts's; applying it is this route's,
  // because the cookie's name and lifetime are deployment surface that
  // the identity rules themselves have no business knowing.
  const { visitorId, consentful, cookie } = resolveVisitorIdentity({
    consent: event.envelope.consent,
    visitorCookie: parseCookies(req.headers.cookie)[VISITOR_ID_COOKIE],
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
  const sessionId = resolveSessionId(lastEvent, now);

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
    props: event.props,
    idempotencyKey: event.envelope.idempotencyKey,
    consentMode: consentful ? "consentful" : "consentless",
  });
}
