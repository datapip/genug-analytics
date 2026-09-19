import { z } from "zod";

// The fixed shape every event arrives in, regardless of event type.
// `props` is validated here only as an open record — routes/events.ts
// re-validates it against the specific event's schema once `event` has
// been looked up in the registry.
// Every string is length-capped to bound a slow disk-exhaustion path —
// see "Data model" in docs/decisions.md for the full reasoning. Caps are
// generous on purpose: they exist to stop abuse, not to second-guess
// real data. `props` is bounded instead by the request body as a whole
// (routes/events.ts), since prop shapes are the deployment's business.
const MAX_URL_LENGTH = 2048; // the de facto browser/CDN URL ceiling
export const MAX_EVENT_NAME_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

// The three events the bundled client script fires on its own. It sends
// the role rather than a name, because it does not know what this
// deployment calls them — the server resolves it against the registry
// (see routes/events.ts). Everything else, including every manual
// track() call and every data-genug-on-click attribute, names its event.
export const AUTO_EVENT_ROLES = [
  "pageView",
  "outboundClick",
  "fileDownload",
] as const;

export const envelopeSchema = z
  .object({
    // Capped even though an unregistered name is rejected moments later:
    // the rejection itself is stored, so an unbounded name would still
    // reach the disk.
    event: z.string().max(MAX_EVENT_NAME_LENGTH).optional(),
    auto: z.enum(AUTO_EVENT_ROLES).optional(),
    // No default. Absent is a real third state, distinct from `false`: a
    // consent manager that hasn't answered yet, or a deployment with no
    // banner at all — see "Visitor identification" in docs/decisions.md
    // for why the server must not treat that the same as an explicit "no".
    consent: z.boolean().optional(),
    // A real absolute URL, not just a string: the client always sends
    // location.href, so this only rejects what was never going to
    // aggregate anyway — parseUrl would fall back to the raw value as the
    // "path" and quietly pollute get_top_pages. A rejection is visible in
    // get_top_rejected_events; nonsense in a ranking is not.
    // http(s) only. z.url() accepts javascript:, data: and file:, none
    // of which is a page anyone visited — and all of which would be
    // stored verbatim from a public endpoint, read back to an agent,
    // and rendered in the cockpit, where they are one careless href
    // away from executing. Rejecting is visible in
    // get_top_rejected_events; storing nonsense is not.
    url: z
      .url()
      .max(MAX_URL_LENGTH)
      // A prefix test, not new URL().protocol: a refinement that throws
      // turns safeParse into a thrown error, and every value this needs
      // to reject is one new URL() throws on.
      .refine(
        (value) => /^https?:\/\//i.test(value),
        "url must be http or https",
      ),
    // NOT validated as a URL, unlike `url` above: document.referrer is ""
    // for a visitor arriving directly, which is the common case and not
    // an error. getTopReferrers already treats an unparseable referrer as
    // direct traffic.
    referrer: z.string().max(MAX_URL_LENGTH).optional(),
    // Optional, deployment-supplied dedup key (e.g. a real order id) —
    // see idx_events_dedup in db/migrations.ts. On the envelope rather
    // than in props, being fixed metadata that means the same thing for
    // every event type, exactly like `consent`.
    idempotencyKey: z.string().max(MAX_IDEMPOTENCY_KEY_LENGTH).optional(),
    props: z.record(z.string(), z.unknown()),
  })
  // Exactly one, never both and never neither. Both would make the
  // stored event name depend on which one the server happened to read
  // first; neither has nothing to store at all.
  .refine(
    (envelope) =>
      (envelope.event === undefined) !== (envelope.auto === undefined),
    {
      message: 'exactly one of "event" or "auto" is required',
    },
  );

export type Envelope = z.infer<typeof envelopeSchema>;
