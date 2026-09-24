import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  checkEvent,
  EVENT_NAME_RULE,
  isValidEventName,
} from "@genug/schema-registry";

// Creates one event file from the cockpit's New event form.
//
// Editing an existing event is words-only (lib/editEvent.ts) because a
// changed rule string can start rejecting events that are already
// arriving. Creating one is different in the way that matters: a name
// nothing has sent yet has no traffic to break and no history to
// strand, so the worst a wrong shape costs is a file you fix before
// pointing anything at it.
//
// The browser still never sends a rule string. It sends a type picked
// from a fixed list plus two checkboxes, and this composes
// "string.long.optional" itself — so a malformed rule is unreachable
// from a browser rather than merely rejected by the checker.
//
// Role tags are not offered at all. Only one event may carry each, and
// when two do the winner is decided by name order — so a form that
// could tick "_pageView" would be a one-click way to displace the
// deployment's real page-view event and strand its history. Moving a
// role stays a file edit, where it is a deliberate act.

export type PropTypeChoice = "text" | "longText" | "number" | "boolean";

export interface PropSpec {
  name: string;
  type: PropTypeChoice;
  optional: boolean;
  list: boolean;
  description: string;
  // One entry for an ordinary prop, several for a list. Text either
  // way: the controls are typed, but an input's value is a string, and
  // the declared type is what says how to read it back.
  example: string[];
}

export interface EventCreate {
  name: string;
  description: string;
  props: PropSpec[];
}

export type CreateResult =
  | { ok: true; name: string; adoptedRows: number }
  | { ok: false; error: string };

// The closed set of shapes the form can express. `long` is a type
// choice rather than a modifier checkbox on purpose: parseRule rejects
// "number.long", and an option that is invalid in three of four
// combinations is better not offered than validated.
const RULE_TYPE: Readonly<Record<PropTypeChoice, string>> = {
  text: "string",
  longText: "string.long",
  number: "number",
  boolean: "boolean",
};

function failed(error: string): CreateResult {
  return { ok: false, error };
}

// Exported for lib/addEventProp.ts, which composes a rule string the
// same way for the one prop it adds to an already-live event.
export function composeRule(spec: PropSpec): string {
  let rule = RULE_TYPE[spec.type];
  if (spec.optional) rule += ".optional";
  if (spec.list) rule += ".list";
  return rule;
}

export function createEventFile(
  db: Database.Database,
  directory: string,
  create: EventCreate,
): CreateResult {
  if (!isValidEventName(create.name)) {
    return failed(
      `"${create.name}" cannot be an event name. The file is named after ` +
        `the event, so ${EVENT_NAME_RULE}.`,
    );
  }

  const path = join(directory, `${create.name}.json`);
  if (existsSync(path)) {
    return failed(
      `${create.name}.json already exists. Edit that event instead, or ` +
        `pick a name nothing else uses.`,
    );
  }

  const file: Record<string, unknown> = { _description: create.description };

  const seen = new Set<string>();
  for (const spec of create.props) {
    // Two props of one name would silently collapse into one key, and
    // the event would register missing a prop its author wrote down.
    if (seen.has(spec.name)) {
      return failed(
        `"${spec.name}" is declared twice. Each prop needs its own name.`,
      );
    }
    seen.add(spec.name);

    const example = parseExample(spec);
    if (!example.ok) {
      return failed(`The example for "${spec.name}" ${example.error}`);
    }

    file[spec.name] = composeRule(spec);
    file[`${spec.name}_description`] = spec.description;
    file[`${spec.name}_example`] = example.value;
  }

  // The loader's own checker, before anything reaches disk rather than
  // after — the same rule the editor follows, so a file this wrote is
  // always a file that loads. It catches what this function cannot know
  // to look for: a prop named `page_title_description`, an example
  // longer than its own cap.
  const checked = checkEvent(file);
  if (!checked.ok) {
    return failed(`Not created — ${checked.errors.join("; ")}`);
  }

  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");

  // Rows may already be stored under this name, orphaned by an earlier
  // rename or deletion. Creating the event hands them back to it, which
  // is usually the point — but it is disclosed rather than discovered,
  // the same way a rename discloses it.
  return {
    ok: true,
    name: create.name,
    adoptedRows: countStored(db, create.name),
  };
}

function countStored(db: Database.Database, event: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE event = ?`)
    .get(event) as { count: number };
  return row.count;
}

export type ParsedExample =
  { ok: true; value: unknown } | { ok: false; error: string };

// Typed controls hand back text, so the declared type decides how to
// read it. Rejecting here rather than letting checkEvent's
// exampleMismatch do it buys a message about what was typed instead of
// one about what the file ended up containing.
//
// Exported for lib/addEventProp.ts — same controls, same reading.
export function parseExample(spec: PropSpec): ParsedExample {
  const values: (string | number | boolean)[] = [];

  for (const raw of spec.example) {
    if (spec.type === "number") {
      const value = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(value)) {
        return { ok: false, error: `is not a number: "${raw}".` };
      }
      values.push(value);
      continue;
    }

    if (spec.type === "boolean") {
      if (raw !== "true" && raw !== "false") {
        return { ok: false, error: `has to be true or false, not "${raw}".` };
      }
      values.push(raw === "true");
      continue;
    }

    values.push(raw);
  }

  if (spec.list) return { ok: true, value: values };

  // The form only ever renders one control for a prop that is not a
  // list, so this is a malformed request rather than a typo.
  if (values.length !== 1) {
    return { ok: false, error: `needs exactly one value.` };
  }
  return { ok: true, value: values[0] };
}
