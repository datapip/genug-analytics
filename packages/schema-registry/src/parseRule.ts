// A prop's shape, written as a rule string with dots in the event's JSON
// file: `"page_title": "string.long"`. The first part is the type
// (required); the rest are modifiers, in any order.
//
// JSON Schema would be the standard, but it was not used on purpose:
// these files are meant to be edited by hand on a server, and a
// {"type":"string","maxLength":512} object under every prop is harder
// to read. This format is simpler, so JSON Schema could still be
// generated from it later. See docs/decisions.md.

export type PropTypeName = "string" | "number" | "boolean";

const TYPE_NAMES: readonly string[] = ["string", "number", "boolean"];

// The longest any string prop may be. The same as envelope.ts allows for
// a url, because a prop holding a URL is the usual long case.
//
// POST /events is public, and several MCP tools show stored prop values
// to the agent as they are. Without a limit, a stranger could put up to
// 16KB of text into the agent's context. A limit doesn't make prompt
// injection impossible, but it leaves little room for it.
export const MAX_PROP_STRING_LENGTH = 2048;

// The default limit for a text prop: enough for a title or a label, too
// short to hide a paragraph of instructions.
export const DEFAULT_PROP_STRING_LENGTH = 512;

// `long` picks the longer limit, so nobody has to choose a number.
// `required` and `optional` are named as in JSON Schema and Protobuf.
const LENGTH_WORDS: Record<string, number> = {
  short: DEFAULT_PROP_STRING_LENGTH,
  long: MAX_PROP_STRING_LENGTH,
};

const OPTIONALITY_WORDS: Record<string, boolean> = {
  required: true,
  optional: false,
};

// How many values one list prop may hold. The request size limit
// already prevents extremes; this keeps breakdowns readable. A prop with
// hundreds of values is almost always several events that should be
// sent separately.
export const MAX_PROP_LIST_LENGTH = 50;

// `list` works with all three types: one rule is simpler to explain
// than exceptions, and `boolean.list` is useless but harmless.
const SHAPE_WORDS: Record<string, boolean> = { list: true };

const VALID_WORDS = [
  ...Object.keys(OPTIONALITY_WORDS),
  ...Object.keys(LENGTH_WORDS),
  ...Object.keys(SHAPE_WORDS),
].join(", ");

// A union type rather than an optional `maxLength`, so the compiler
// knows a string rule always has a limit. `number.long` is rejected
// rather than ignored.
export type PropRule =
  | { type: "string"; required: boolean; list: boolean; maxLength: number }
  | { type: "number" | "boolean"; required: boolean; list: boolean };

export type ParsedRule =
  { ok: true; rule: PropRule } | { ok: false; error: string };

// Doesn't know which prop or file the rule is from; the caller adds that
// to the error message.
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
    // Only quote the whole rule when it is more than the type: `unknown
    // type "strng" in "strng"` would look like a bug.
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
    // Object.hasOwn, not `in`: with `in`, "string.constructor" would
    // match a built-in object key and count as valid.
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
        // The length limit applies to each value; MAX_PROP_LIST_LENGTH
        // limits how many there are.
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
