import { z } from "zod";

// The fixed shape every event arrives in, whatever its type. `props` is
// only checked as an object here; routes/events.ts checks it against
// the event's own schema once the event is known.
// Every string has a length limit, so nobody can slowly fill the disk
// (see "Data model" in docs/decisions.md). The limits are generous:
// they stop abuse, not real data. `props` is limited by the size of the
// whole request instead (routes/events.ts).
export const MAX_URL_LENGTH = 2048; // the de facto browser/CDN URL ceiling
export const MAX_EVENT_NAME_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const REFERRER_PROTOCOLS = new Set(["http:", "https:", "android-app:"]);

// The three events the client script sends by itself. It sends the
// role instead of a name, because it doesn't know what this deployment
// calls them; the server looks the name up (see routes/events.ts).
// Everything else, such as track() calls and data-genug-on-click
// attributes, sends an event name.
export const AUTO_EVENT_ROLES = [
  "pageView",
  "outboundClick",
  "fileDownload",
] as const;

export const envelopeSchema = z
  .object({
    // Limited even though an unknown name is rejected right after,
    // because the rejection is stored together with the name.
    event: z.string().max(MAX_EVENT_NAME_LENGTH).optional(),
    auto: z.enum(AUTO_EVENT_ROLES).optional(),
    // No default. Missing is a third state, not `false`: the consent
    // banner hasn't answered yet, or the site has none. See "Visitor
    // identification" in docs/decisions.md for why the server must not
    // treat it as "no".
    consent: z.boolean().optional(),
    // A full URL. The client always sends location.href, so this only
    // rejects junk that would otherwise show up as a strange page in
    // get_top_pages. A rejection is visible in get_top_rejected_events.
    // Only http(s): z.url() also accepts javascript:, data: and file:,
    // which are never real pages, and such a URL shown as a link in the
    // cockpit could run code.
    url: z
      .url()
      .max(MAX_URL_LENGTH)
      // A prefix check, not new URL().protocol: new URL() throws on bad
      // input, and a throwing refinement makes safeParse throw too.
      .refine(
        (value) => /^https?:\/\//i.test(value),
        "url must be http or https",
      ),
    // "" or a URL with a scheme from a short list. Not only http(s), as
    // for `url`: Chrome on Android sends
    // android-app://com.google.android.gm/ for a click in the Gmail app,
    // which is a real visit. "" is a direct visit, the common case. A
    // list rather than any "scheme://", because javascript://%0aalert(1)
    // matches that and runs as code in a link, and the agent's client may
    // show the referrer as a link. Same length limit as `url`, since
    // after the first page the referrer is this site's previous URL.
    referrer: z
      .string()
      .max(MAX_URL_LENGTH)
      // URL.canParse first, because a throwing refinement makes
      // safeParse throw too.
      .refine(
        (value) =>
          value === "" ||
          (URL.canParse(value) &&
            REFERRER_PROTOCOLS.has(new URL(value).protocol)),
        'referrer must be "" or an http, https or android-app URL',
      )
      .optional(),
    // Optional key against duplicates, such as an order id (see
    // idx_events_dedup in db/migrations.ts). On the envelope rather than
    // in props, because it means the same for every event type, like
    // `consent`.
    idempotencyKey: z.string().max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
    props: z.record(z.string(), z.unknown()),
  })
  // Exactly one of `event` and `auto`. With both, it would be unclear
  // which name to store; with neither, there is nothing to store.
  .refine(
    (envelope) =>
      (envelope.event === undefined) !== (envelope.auto === undefined),
    {
      message: 'exactly one of "event" or "auto" is required',
    },
  );

export type Envelope = z.infer<typeof envelopeSchema>;
