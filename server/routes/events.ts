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
  roleEventNames,
  MAX_EVENT_NAME_LENGTH,
} from "@genug/schema-registry";
import { db } from "../db/index.js";
import { insertEvent, findLastEventForVisitor } from "../db/events.js";
import { insertRejectedEvent } from "../db/rejectedEvents.js";
import {
  dailySalt,
  consentlessVisitorId,
  isIssuedVisitorId,
} from "../lib/identity.js";
import { truncateIp } from "../lib/ip.js";
import { resolveSessionId } from "../lib/session.js";
import { requireEnv } from "../lib/env.js";
import { isBotUserAgent } from "../lib/bots.js";
import { classifyUserAgent } from "../lib/userAgent.js";
import { stripUnknownParams } from "../lib/url.js";
import { recordBotHit, botActivityCounter } from "../lib/botActivity.js";
import { parseCookies } from "../lib/cookies.js";

const VISITOR_ID_COOKIE = "genug_vid";
// 13 months — the ceiling EU data-protection authorities (CNIL, and the
// German DSK following it) treat as the maximum life for an analytics
// identifier. Chrome would allow 400 days; the shorter one is what's
// defensible for the EU deployments this is built for.
const VISITOR_ID_COOKIE_MAX_AGE_MS = 396 * 24 * 60 * 60 * 1000;

// A comma-separated list, because one site legitimately has more than
// one origin: an apex plus a `www.` host that doesn't redirect, or a
// staging host reporting to the same collector. Every entry still has to
// match exactly — this widens the set of known origins, it never relaxes
// into a wildcard or an echo-anything policy.
//
// Fail-fast on an empty result, same spirit as parsePort: requireEnv only
// proves the variable is set, not that it holds an origin. It matters
// more here than elsewhere because an unlisted origin fails inside the
// browser, which leaves no trace in this server's logs at all.
//
// requireEnv always returns a plain `string` (never `string | undefined`),
// so — unlike a local `if (!x) throw` guard — this is safe to read from
// `cors`, a hoisted function declared below.
const allowedOrigins = new Set(
  requireEnv("ALLOWED_ORIGIN")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
);
if (allowedOrigins.size === 0) {
  throw new Error(
    "ALLOWED_ORIGIN must name at least one origin (comma-separated for more than one)",
  );
}
const saltSecret = requireEnv("SALT_SECRET");

// Plain boolean, not a type predicate: event names come from JSON files
// read at startup, so `EventType` is `string` and narrowing to it would
// say nothing. The runtime check is the real one either way, and it has
// to be — hasOwnProperty rather than `in`, because `in` also matches
// inherited Object.prototype keys ("constructor", "toString"), which
// would look up a registry entry that isn't an event at all.
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
function cors(req: Request, res: Response, next: NextFunction): void {
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

export const eventsRouter: Router = Router();

eventsRouter.use(cors);

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

eventsRouter.post("/", parseBody, (req: Request, res: Response) => {
  // Stamped once, up front, and reused everywhere below (a rejected
  // request's ts, a real event's ts, the daily salt) — same reasoning
  // as the rest of this file's identity logic: one reading of the
  // clock per request, not a slightly-different one at each call site.
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
      res.clearCookie(VISITOR_ID_COOKIE, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      });
    }
    res.status(204).end();
    return;
  }

  const envelopeResult = envelopeSchema.safeParse(req.body);
  if (!envelopeResult.success) {
    // req.body's shape is unknown at this point (that's exactly what
    // just failed) — event is opportunistic, best-effort only.
    const maybeEvent =
      typeof req.body === "object" &&
      req.body !== null &&
      typeof (req.body as Record<string, unknown>).event === "string"
        ? // Truncated to the same cap envelopeSchema enforces: the
          // schema rejected this body, so the name never passed that
          // check, and the envelope's comment is explicit that the cap
          // exists precisely because the rejection is what reaches disk.
          (req.body as { event: string }).event.slice(0, MAX_EVENT_NAME_LENGTH)
        : undefined;
    insertRejectedEvent(
      db,
      "invalid_envelope",
      now.toISOString(),
      maybeEvent,
      firstIssueDetail(envelopeResult.error),
    );
    res.status(400).json({ error: "invalid envelope" });
    return;
  }
  const envelope = envelopeResult.data;

  // The client script sends a role rather than a name for the three
  // events it fires itself, because it does not know what this
  // deployment calls them — so the name is decided here, from the
  // registry, on every request. A cached copy of the script therefore
  // cannot send a name that no longer exists, which is what renaming
  // one of those events used to cost.
  //
  // A literal `event` is folded to lowercase before it's looked up:
  // every registered name is enforced lowercase (isValidEventName), so
  // this only ever helps — a track() call with stray-case matches the
  // event it plainly meant instead of being rejected as unknown over
  // nothing but casing. A role-resolved name is already lowercase from
  // the registry, so lowercasing it again is a no-op.
  const eventName =
    envelope.event?.toLowerCase() ??
    (envelope.auto === undefined ? undefined : roleEventNames[envelope.auto]);

  if (eventName === undefined || !isKnownEventType(eventName)) {
    // An unresolved role is stored under the role it asked for, with the
    // tag to add as the detail. Same reason/counter as a mistyped event
    // name: one place to look when something isn't being recorded.
    insertRejectedEvent(
      db,
      "unknown_event_type",
      now.toISOString(),
      eventName ?? envelope.auto,
      eventName === undefined
        ? `no registered event carries "_${AUTO_ROLE_TAG_KEYS[envelope.auto!]}": true`
        : undefined,
    );
    res.status(400).json({
      error:
        eventName === undefined
          ? `no event is registered for automatic ${envelope.auto} tracking`
          : `unknown event type: ${eventName}`,
    });
    return;
  }

  // Folded the same way the event name is, and for the same reason: every
  // declared prop name is enforced lowercase, so a stray-case key from the
  // client (a typo'd data-genug-props, or a site's own inconsistent casing)
  // matches the prop it plainly meant instead of tripping the schema's
  // strict "unrecognized key" rejection over nothing but casing.
  const lowercasedProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.props)) {
    lowercasedProps[key.toLowerCase()] = value;
  }

  // The link a visitor clicked carries the same ?email= and tokens a page
  // URL can, so it gets the same allowlist. The client strips it too;
  // this is the backstop, as for `url`. Keyed on the resolved event, not
  // on how it was sent, so a track() call naming the event by hand is
  // filtered the same way and the prop's description stays true. Only
  // these two events: there the client script fixes the prop name, while
  // a deployment's own props are its own to name.
  for (const [role, prop] of Object.entries(ROLE_URL_PROPS)) {
    const linkUrl = lowercasedProps[prop];
    if (
      roleEventNames[role as keyof typeof roleEventNames] === eventName &&
      typeof linkUrl === "string"
    ) {
      lowercasedProps[prop] = stripUnknownParams(linkUrl);
    }
  }

  const propsResult =
    eventRegistry[eventName].schema.safeParse(lowercasedProps);
  if (!propsResult.success) {
    insertRejectedEvent(
      db,
      "invalid_props",
      now.toISOString(),
      eventName,
      firstIssueDetail(propsResult.error),
    );
    res.status(400).json({ error: "invalid props for event type" });
    return;
  }

  // Narrowed to a block before it is hashed (see lib/ip.ts). The rate
  // limiter above narrows differently, and less: it keeps an IPv4
  // address whole, because it has to tell one abuser from the office
  // around them.
  const ip = truncateIp(req.ip ?? "");
  const userAgent = req.headers["user-agent"];
  // The header itself goes no further than this request: it feeds the
  // bot check above and the consentless hash below, and only what it
  // classifies to is stored (see db/migrations.ts).
  const device =
    userAgent === undefined ? undefined : classifyUserAgent(userAgent);
  const visitorLanguage = parsePrimaryLanguage(req.headers["accept-language"]);

  const salt = dailySalt(saltSecret, now);

  const cookies = parseCookies(req.headers.cookie);

  const rawCookie = cookies[VISITOR_ID_COOKIE];
  // A cookie that doesn't look like one this server issued is ignored
  // rather than trusted — see isIssuedVisitorId.
  const existingCookie =
    rawCookie && isIssuedVisitorId(rawCookie) ? rawCookie : undefined;

  let visitorId: string;
  let consentful: boolean;

  if (envelope.consent === false) {
    // An explicit "no" — not merely absent. A cookie is never trusted
    // here even if one was sent, and is removed if present: Art. 7(3)
    // ("as easy to withdraw as to give") requires actually removing the
    // identifier, and since the cookie is httpOnly, the tracked site's
    // own JavaScript cannot delete it — only this response can.
    visitorId = consentlessVisitorId(ip, userAgent ?? "", salt);
    consentful = false;
    if (cookies[VISITOR_ID_COOKIE]) {
      res.clearCookie(VISITOR_ID_COOKIE, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      });
    }
  } else {
    // consent === true, or not sent at all (a consent manager that
    // hasn't answered yet on this particular request, or a deployment
    // with no banner). Either way, a cookie already on the request
    // wins: its mere presence already proves this browser consented
    // before, and only an explicit `false` above removes that trust.
    // This is what closes the race an unanswered auto page-view used to
    // lose — it no longer clears a returning, already-consented
    // visitor's cookie just because this one request doesn't (yet)
    // confirm it. See "Visitor identification" in docs/decisions.md.
    visitorId =
      existingCookie ?? consentlessVisitorId(ip, userAgent ?? "", salt);
    // A visitor with no cookie who also hasn't answered gets the
    // ordinary ephemeral hash and nothing is set below. One who just
    // said yes gets a fresh persistent cookie frozen from today's hash
    // rather than a random UUID (see "Consentless → consentful
    // transition").
    consentful = existingCookie !== undefined || envelope.consent === true;
    if (consentful) {
      res.cookie(VISITOR_ID_COOKIE, visitorId, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: VISITOR_ID_COOKIE_MAX_AGE_MS,
      });
    }
  }

  const lastEvent = findLastEventForVisitor(db, visitorId);
  const sessionId = resolveSessionId(lastEvent, now);

  insertEvent(db, {
    event: eventName,
    visitorId,
    sessionId,
    ts: now.toISOString(),
    // Stripped here as well as in the client: /events is public, so a
    // caller that isn't the client script reaches this line with whatever
    // query string it likes. See lib/url.ts.
    url: stripUnknownParams(envelope.url),
    referrer:
      envelope.referrer === undefined
        ? undefined
        : stripUnknownParams(envelope.referrer),
    deviceType: device?.deviceType,
    browser: device?.browser,
    visitorLanguage,
    props: propsResult.data,
    idempotencyKey: envelope.idempotencyKey,
    consentMode: consentful ? "consentful" : "consentless",
  });

  // A deduped duplicate still gets the same 204 a real event does — the
  // client can't tell the difference, same as the bot-drop above, so a
  // refreshed confirmation page never sees an error to retry or surface.
  res.status(204).end();
});
