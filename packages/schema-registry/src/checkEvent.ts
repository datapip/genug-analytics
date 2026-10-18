import { parseRule, MAX_PROP_LIST_LENGTH, type PropRule } from "./parseRule.js";

// Checks one event file's parsed JSON. It doesn't touch the filesystem,
// doesn't know which file it is checking, and never throws. The caller
// decides what a failure means: a built-in file stops startup, a file on
// the volume is skipped and reported.
//
// It collects every error instead of stopping at the first, so someone
// editing a file by hand can fix all of them at once instead of one per
// restart.

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

// The event-level keys. `_note` is for comments, since JSON has none.
// Its text is ignored and never shown anywhere.
const EVENT_TEXT_KEYS = ["_description", "_note"] as const;

// The JSON key for each role tag.
//
// Two are named after the automatic client behaviour they are for,
// because that is all they do: they tell the server which event an
// automatic outbound click or download is stored as.
//
// `_pageView` isn't called `_automaticPageView`, on purpose. It marks
// the event that means a page view, which many queries depend on (top
// pages, entry/exit/bounce, the traffic summary), also for sites that
// send page views by hand. enableAutoPageTracking is off by default, so
// that is the common case.
export const ROLE_TAG_KEYS: Readonly<Record<EventRole, string>> = {
  pageView: "_pageView",
  outboundClick: "_automaticOutboundClick",
  fileDownload: "_automaticFileDownload",
};

export type EventRole = "pageView" | "outboundClick" | "fileDownload";

// The same pairs the other way round (role → key), so an error can name
// the key as written in the file. Built from the map above so the two
// can't disagree.
const EVENT_TAG_KEYS: Readonly<Record<string, EventRole>> = Object.fromEntries(
  Object.entries(ROLE_TAG_KEYS).map(([role, key]) => [key, role as EventRole]),
);

// A simple flag, unlike the role tags: it marks the event as a business
// goal for the agent to know about. No code behaves differently because
// of it, so any number of events may have it; a site with several goals
// (signup, purchase, newsletter) marks each one. It isn't a role tag,
// because role tags exist for the client and routes/events.ts to find
// an event by its role.
const CONVERSION_KEY = "_conversion";

const EVENT_KEYS: readonly string[] = [
  ...EVENT_TEXT_KEYS,
  ...Object.keys(EVENT_TAG_KEYS),
  CONVERSION_KEY,
];

// Suffixes that always belong to the prop named before them. So a prop
// can't be called `page_title_description`: that key is page_title's
// description.
const RESERVED_SUFFIXES = ["_description", "_example", "_note"] as const;

// The same rule as isValidPropertyKey in server/lib/events.ts: other
// names couldn't be read with json_extract('$.key'), so
// get_events_by_property couldn't query the prop. Lowercase only, like
// event names: routes/events.ts lowercases incoming prop names, so
// "Product_Id" and "product_id" would clash.
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

  // An unknown key starting with `_` is a typo in a metadata name
  // (`_categroy`). Ignoring it would register the event without what the
  // author meant to write.
  for (const key of Object.keys(raw)) {
    if (key.startsWith("_") && !EVENT_KEYS.includes(key)) {
      errors.push(
        `unknown event key "${key}" — valid: ${EVENT_KEYS.join(", ")}`,
      );
    }
  }

  // The event must have a description.
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

  // A key like `page_title_description` whose prop (`page_title`) isn't
  // declared. Either the prop was renamed and this was left behind, or
  // someone tried to name a prop that way. Report it instead of guessing.
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

    // The rule string (type and modifiers) is checked by parseRule.
    const parsed = parseRule(raw[name]);
    if (!parsed.ok) {
      errors.push(`prop "${name}": ${parsed.error}`);
      continue;
    }

    // Every prop needs a description: the agent reads the registry to
    // understand the data, and without one it would have to guess.
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

    // The example must follow the prop's own rule. The agent takes it as
    // typical of the data, so an example the schema would reject would
    // mislead it.
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
  // The prop's value may be an empty list (a page without tags is fine),
  // but the example may not: it is the only thing showing the agent what
  // the values look like.
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
    // Infinity and NaN are numbers to typeof, but JSON.stringify turns
    // both into null.
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `must be a finite number`;
    }
    return undefined;
  }
  if (typeof value !== "boolean") return `must be true or false`;
  return undefined;
}
