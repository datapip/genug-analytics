import { parseRule, MAX_PROP_LIST_LENGTH, type PropRule } from "./parseRule.js";

// Checks one event file's parsed JSON. Pure — no filesystem, no
// knowledge of which file this came from, and it never throws. The
// caller decides what a failure means: a file baked into the image
// crashes startup, a file on the volume is skipped and reported.
//
// Every error is collected rather than the first one thrown, because
// the audience is someone hand-editing a file on a server who would
// otherwise fix one typo per restart.

export type PropScalar = string | number | boolean;

export interface CheckedProp {
  rule: PropRule;
  description: string;
  example: PropScalar | PropScalar[];
}

export interface CheckedEvent {
  description: string;
  pageView: boolean;
  outboundClick: boolean;
  fileDownload: boolean;
  conversion: boolean;
  props: Record<string, CheckedProp>;
}

export type CheckedResult =
  { ok: true; event: CheckedEvent } | { ok: false; errors: string[] };

// Event-level metadata. `_note` is the format's comment: plain JSON has
// none, and the alternative was a JSONC parser dependency. The checker
// ignores its content and no consumer ever sees it.
const EVENT_TEXT_KEYS = ["_description", "_note"] as const;

// Which JSON key writes each role tag.
//
// Two of them are named for the client behaviour they switch on,
// because that is genuinely all they do: nothing server-side reads
// either one, and their only job is telling the bundled script which
// event to record an automatic outbound click or download as.
//
// `_pageView` is not named that way, deliberately. It marks the event
// that *means* a page view, which a dozen queries resolve through
// (top pages, entry/exit/bounce, the traffic-summary split), and it has
// to keep working for a deployment that fires page views by hand —
// enableAutoPageTracking is off by default, so that is the common case.
// `_automaticPageView` would name the smaller half of its job.
export const ROLE_TAG_KEYS: Readonly<Record<EventRole, string>> = {
  pageView: "_pageView",
  outboundClick: "_automaticOutboundClick",
  fileDownload: "_automaticFileDownload",
};

export type EventRole = "pageView" | "outboundClick" | "fileDownload";

// The same pairs read the other way, which is the direction a file is
// checked in. Derived rather than written twice: a rejection has to
// name the key someone actually typed, and two hand-kept maps drift.
const EVENT_TAG_KEYS: Readonly<Record<string, EventRole>> = Object.fromEntries(
  Object.entries(ROLE_TAG_KEYS).map(([role, key]) => [key, role as EventRole]),
);

// A plain flag, unlike the three role tags above: it marks the event as
// counting toward a business goal, for an agent or a future query to
// read. Nothing resolves behaviour through it, and no query branches on
// it yet — so unlike a role tag, any number of events may carry it. A
// deployment with several goals (signup, purchase, newsletter) tags
// each. Kept out of ROLE_TAG_KEYS/EventRole on purpose: those three
// exist because the client and routes/events.ts resolve behaviour
// through them, which this has no need of and no reason to grow into.
const CONVERSION_KEY = "_conversion";

const EVENT_KEYS: readonly string[] = [
  ...EVENT_TEXT_KEYS,
  ...Object.keys(EVENT_TAG_KEYS),
  CONVERSION_KEY,
];

// Suffixes that always belong to the prop named before them, never to a
// prop of their own. So a prop cannot be called `page_title_description`
// — that name is already page_title's description.
const RESERVED_SUFFIXES = ["_description", "_example", "_note"] as const;

// Same rule as isValidPropertyKey in server/lib/events.ts: a name with
// anything else in it can't be reached by json_extract('$.key'), so the
// prop would be stored and then be unqueryable by get_events_by_property.
// Lowercase only, for the same reason event names are: "Product_Id" and
// "product_id" would otherwise be two declarable props that collide the
// moment routes/events.ts folds an incoming prop key to lowercase.
const PROP_NAME_PATTERN = /^[a-z0-9_]+$/;

export function checkEvent(value: unknown): CheckedResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      errors: ["must be a JSON object — one file describes one event"],
    };
  }

  const raw = value as Record<string, unknown>;
  const errors: string[] = [];

  // Rule 9: an unknown `_`-prefixed key is a typo in a metadata name
  // (`_categroy`), and silently ignoring it means the event registers
  // without the thing the author thought they wrote.
  for (const key of Object.keys(raw)) {
    if (key.startsWith("_") && !EVENT_KEYS.includes(key)) {
      errors.push(
        `unknown event key "${key}" — valid: ${EVENT_KEYS.join(", ")}`,
      );
    }
  }

  // Rule 7.
  const description = requireText(raw, "_description", errors);
  if ("_note" in raw && typeof raw._note !== "string") {
    errors.push(`"_note" must be a string`);
  }

  const tags: Record<EventRole, boolean> = {
    pageView: false,
    outboundClick: false,
    fileDownload: false,
  };
  for (const [key, role] of Object.entries(EVENT_TAG_KEYS)) {
    if (!(key in raw)) continue;
    if (typeof raw[key] !== "boolean") {
      errors.push(`"${key}" must be true or false`);
      continue;
    }
    tags[role] = raw[key] as boolean;
  }

  let conversion = false;
  if (CONVERSION_KEY in raw) {
    if (typeof raw[CONVERSION_KEY] !== "boolean") {
      errors.push(`"${CONVERSION_KEY}" must be true or false`);
    } else {
      conversion = raw[CONVERSION_KEY] as boolean;
    }
  }

  const propNames = Object.keys(raw).filter(
    (key) =>
      !key.startsWith("_") &&
      !RESERVED_SUFFIXES.some((suffix) => key.endsWith(suffix)),
  );

  // Rule 10, the other half: a key like `page_title_description` whose
  // base name isn't a declared prop. Either the prop was renamed and
  // this was left behind, or someone tried to name a prop that. Guessing
  // which is worse than saying so.
  for (const key of Object.keys(raw)) {
    if (key.startsWith("_")) continue;
    const suffix = RESERVED_SUFFIXES.find((candidate) =>
      key.endsWith(candidate),
    );
    if (suffix === undefined) continue;
    const base = key.slice(0, -suffix.length);
    if (base.length > 0 && propNames.includes(base)) continue;
    errors.push(
      `"${key}" describes a prop "${base}" that isn't declared — ` +
        `names ending in ${RESERVED_SUFFIXES.join(", ")} always belong to ` +
        `the prop named before them, so a prop cannot be called that`,
    );
  }

  const props: Record<string, CheckedProp> = {};

  for (const name of propNames) {
    if (!PROP_NAME_PATTERN.test(name)) {
      errors.push(
        `prop "${name}" may only contain lowercase letters, digits and ` +
          `underscores — anything else cannot be read back by get_events_by_property`,
      );
      continue;
    }

    // Rules 1-4, delegated.
    const parsed = parseRule(raw[name]);
    if (!parsed.ok) {
      errors.push(`prop "${name}": ${parsed.error}`);
      continue;
    }

    // Rule 5. The registry is what an AI agent reads to ground itself
    // before answering a question, so an undescribed prop is the agent
    // being handed unlabeled data and guessing.
    const propDescription = requireText(
      raw,
      `${name}_description`,
      errors,
      `prop "${name}"`,
    );

    const exampleKey = `${name}_example`;
    if (!(exampleKey in raw)) {
      errors.push(
        `prop "${name}" needs "${exampleKey}" — an agent reads it to know ` +
          `what the values actually look like`,
      );
      continue;
    }

    // Rule 6: the example has to obey the prop's own rule. It is shown
    // to the agent as representative, so an example the schema would
    // reject is a lie about the data.
    const mismatch = exampleMismatch(raw[exampleKey], parsed.rule);
    if (mismatch !== undefined) {
      errors.push(`"${exampleKey}" ${mismatch}`);
      continue;
    }

    props[name] = {
      rule: parsed.rule,
      description: propDescription ?? "",
      example: raw[exampleKey] as PropScalar | PropScalar[],
    };
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    event: {
      description: description!,
      pageView: tags.pageView,
      outboundClick: tags.outboundClick,
      fileDownload: tags.fileDownload,
      conversion,
      props,
    },
  };
}

function requireText(
  raw: Record<string, unknown>,
  key: string,
  errors: string[],
  owner?: string,
): string | undefined {
  const where = owner === undefined ? "" : `${owner}: `;
  const value = raw[key];
  if (value === undefined) {
    errors.push(`${where}"${key}" is missing`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${where}"${key}" must be a non-empty string`);
    return undefined;
  }
  return value;
}

// Returns a description of what's wrong, or undefined when the example
// fits its rule.
function exampleMismatch(value: unknown, rule: PropRule): string | undefined {
  if (!rule.list) return scalarMismatch(value, rule);

  if (!Array.isArray(value)) {
    return `must be an array, because this prop is declared as a list`;
  }
  // The prop itself may arrive empty — a page with no tags is not an
  // error. The *example* may not: it is the only thing telling an agent
  // what these values look like.
  if (value.length === 0) {
    return `must have at least one value to be worth reading`;
  }
  if (value.length > MAX_PROP_LIST_LENGTH) {
    return `has ${value.length} values, over the limit of ${MAX_PROP_LIST_LENGTH}`;
  }
  for (const [index, element] of value.entries()) {
    const mismatch = scalarMismatch(element, rule);
    if (mismatch !== undefined) return `value ${index + 1} ${mismatch}`;
  }
  return undefined;
}

function scalarMismatch(value: unknown, rule: PropRule): string | undefined {
  if (rule.type === "string") {
    if (typeof value !== "string") return `must be a string`;
    if (value.length > rule.maxLength) {
      return `is ${value.length} characters, over this prop's limit of ${rule.maxLength}`;
    }
    return undefined;
  }
  if (rule.type === "number") {
    // Infinity and NaN survive a typeof check but not JSON.stringify,
    // which turns both into null on the way to the agent.
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `must be a finite number`;
    }
    return undefined;
  }
  if (typeof value !== "boolean") return `must be true or false`;
  return undefined;
}
