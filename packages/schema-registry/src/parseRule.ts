// A prop's shape, written as a dot-separated rule string in the event's
// JSON file: `"page_title": "string.long"`. The first segment names the
// type and is required; the rest are modifiers, in any order.
//
// JSON Schema is the real standard for this and was rejected on
// purpose: the point of moving schemas to JSON is that someone can
// hand-edit one file on a server without a build step, and nesting a
// {"type":"string","maxLength":512} object under every prop costs more
// to read than it buys. This format is strictly simpler, so generating
// JSON Schema from it later stays easy if interop ever matters.
// See docs/decisions.md.

export type PropTypeName = "string" | "number" | "boolean";

const TYPE_NAMES: readonly string[] = ["string", "number", "boolean"];

// The hard ceiling any string prop may accept. Deliberately the same
// number envelope.ts allows for a url, because a prop holding a URL is
// the legitimate long case.
//
// This exists because POST /events is public and unauthenticated, and
// several MCP tools hand stored prop values to the AI agent verbatim.
// An uncapped string prop let a stranger write as much text as the 16KB
// body limit allowed straight into the model's context. Capping does
// not make prompt injection impossible; it removes the room to write at
// length.
export const MAX_PROP_STRING_LENGTH = 2048;

// What an ordinary text prop gets without asking. Generous for a title
// or a label, far short of somewhere to hide a paragraph of
// instructions.
export const DEFAULT_PROP_STRING_LENGTH = 512;

// `short` and `long` are the one invented pair here — deliberately
// naming a number nobody should have to reason about. `required` and
// `optional` are borrowed from JSON Schema and Protobuf, for free
// familiarity.
const LENGTH_WORDS: Record<string, number> = {
  short: DEFAULT_PROP_STRING_LENGTH,
  long: MAX_PROP_STRING_LENGTH,
};

const OPTIONALITY_WORDS: Record<string, boolean> = {
  required: true,
  optional: false,
};

// How many values one list prop may hold. The 16KB body limit already
// bounds the pathological case; this is about keeping a breakdown
// readable, and about the fact that a prop holding hundreds of values
// is almost always several events wearing a trench coat.
export const MAX_PROP_LIST_LENGTH = 50;

// Allowed on all three types rather than only the ones that seem
// useful: a uniform rule is less to explain than a carve-out, and
// `boolean.list` being pointless is not the same as it being harmful.
const SHAPE_WORDS: Record<string, boolean> = { list: true };

const VALID_WORDS = [
  ...Object.keys(OPTIONALITY_WORDS),
  ...Object.keys(LENGTH_WORDS),
  ...Object.keys(SHAPE_WORDS),
].join(", ");

// A union rather than an optional `maxLength`, so "a string rule always
// has a cap" is a fact the compiler knows rather than something every
// consumer re-checks. `number.long` is rejected rather than ignored, so
// a cap is never quietly dropped either.
export type PropRule =
  | { type: "string"; required: boolean; list: boolean; maxLength: number }
  | { type: "number" | "boolean"; required: boolean; list: boolean };

export type ParsedRule =
  { ok: true; rule: PropRule } | { ok: false; error: string };

// Pure: knows nothing about which prop or file the rule came from. The
// caller prefixes that context, so one message shape serves both a
// startup crash and a skipped-file report.
export function parseRule(value: unknown): ParsedRule {
  if (typeof value !== "string") {
    return {
      ok: false,
      error:
        `expected a rule string like "string" or "number.optional", got ` +
        `${describe(value)}`,
    };
  }

  const [typeName, ...words] = value.split(".");

  if (typeName === undefined || !TYPE_NAMES.includes(typeName)) {
    // The rule is quoted back only when it says more than the type
    // itself — `unknown type "strng" in "strng"` reads like a bug.
    const inRule = value === typeName ? "" : ` in ${JSON.stringify(value)}`;
    return {
      ok: false,
      error:
        `unknown type ${JSON.stringify(typeName ?? "")}${inRule} — a rule ` +
        `string starts with one of: ${TYPE_NAMES.join(", ")}`,
    };
  }

  let optionalityWord: string | undefined;
  let lengthWord: string | undefined;
  let shapeWord: string | undefined;

  for (const word of words) {
    // Object.hasOwn, not `in`: otherwise "string.constructor" would
    // find a match on the prototype and parse as a valid rule.
    if (Object.hasOwn(OPTIONALITY_WORDS, word)) {
      if (optionalityWord !== undefined) {
        return { ok: false, error: clash(value, optionalityWord, word) };
      }
      optionalityWord = word;
    } else if (Object.hasOwn(LENGTH_WORDS, word)) {
      if (lengthWord !== undefined) {
        return { ok: false, error: clash(value, lengthWord, word) };
      }
      lengthWord = word;
    } else if (Object.hasOwn(SHAPE_WORDS, word)) {
      if (shapeWord !== undefined) {
        return { ok: false, error: clash(value, shapeWord, word) };
      }
      shapeWord = word;
    } else {
      return {
        ok: false,
        error:
          `unknown rule word ${JSON.stringify(word)} in ${JSON.stringify(value)} — ` +
          `valid words: ${VALID_WORDS}`,
      };
    }
  }

  if (lengthWord !== undefined && typeName !== "string") {
    return {
      ok: false,
      error:
        `${JSON.stringify(value)} sets a length on a ${typeName} — ` +
        `"${lengthWord}" only applies to string props`,
    };
  }

  const required =
    optionalityWord === undefined ? true : OPTIONALITY_WORDS[optionalityWord]!;

  const list = shapeWord !== undefined;

  if (typeName === "string") {
    return {
      ok: true,
      rule: {
        type: "string",
        required,
        list,
        // Per value, not for the list as a whole — the cap exists to
        // bound how much text one value can carry into the agent's
        // context, and MAX_PROP_LIST_LENGTH bounds how many there are.
        maxLength: LENGTH_WORDS[lengthWord ?? "short"]!,
      },
    };
  }
  return {
    ok: true,
    rule: { type: typeName as "number" | "boolean", required, list },
  };
}

function clash(rule: string, first: string, second: string): string {
  if (first === second) {
    return `${JSON.stringify(rule)} repeats "${first}"`;
  }
  return `${JSON.stringify(rule)} says both "${first}" and "${second}" — pick one`;
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return JSON.stringify(value) ?? String(value);
}
