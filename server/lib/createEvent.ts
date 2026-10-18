import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  checkEvent,
  EVENT_NAME_RULE,
  isValidEventName,
} from "@genug/schema-registry";
import { countStored } from "./events.js";
import { writeFileAtomic } from "./atomicWrite.js";

// Creates one event file from the cockpit's "New event" form.
//
// Editing an existing event can only change its wording
// (lib/editEvent.ts), because a changed rule string could start rejecting
// events that are already arriving. A new event can define props: nothing
// sends it yet, so a mistake can be fixed before any traffic arrives.
//
// The browser never sends a rule string. It sends a type from a fixed
// list plus two checkboxes, and this function builds the rule (such as
// "string.long.optional") itself, so a browser can't produce an invalid
// one.
//
// Role tags (like `_pageView`) aren't offered. Only one event may have
// each, so ticking one in a form could take the role away from the real
// page-view event and strand its history. Moving a role is done by
// editing the files.

export type PropTypeChoice = "text" | "longText" | "number" | "boolean";

export interface PropSpec {
  name: string;
  type: PropTypeChoice;
  optional: boolean;
  list: boolean;
  description: string;
  // One entry for a normal prop, several for a list. Always text, since
  // form inputs give strings; the declared type says how to read it.
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

// The types the form offers. "Long text" is its own type rather than a
// checkbox, because `long` only works with strings (parseRule rejects
// "number.long").
const RULE_TYPE: Readonly<Record<PropTypeChoice, string>> = {
  text: "string",
  longText: "string.long",
  number: "number",
  boolean: "boolean",
};

function failed(error: string): CreateResult {
  return { ok: false, error };
}

// Also used by lib/addEventProp.ts to build the rule for a new prop.
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
    // Two props with one name would become one key, and one of them
    // would be silently lost.
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

  // Run the loader's check before writing, so every file written here
  // loads. It catches things this function doesn't look for, such as a
  // prop named `page_title_description` or an example over its length
  // limit.
  const checked = checkEvent(file);
  if (!checked.ok) {
    return failed(`Not created — ${checked.errors.join("; ")}`);
  }

  writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);

  // Rows may already be stored under this name, left over from an
  // earlier rename or deletion. The new event takes them over, which is
  // usually wanted, but the response says so, as a rename does.
  return {
    ok: true,
    name: create.name,
    adoptedRows: countStored(db, create.name),
  };
}

export type ParsedExample =
  { ok: true; value: unknown } | { ok: false; error: string };

// Form inputs give text, so the declared type decides how to read it.
// Checking here gives an error about what was typed, rather than a later
// one from checkEvent about the file's contents.
//
// Also used by lib/addEventProp.ts.
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

  // The form shows one input for a prop that isn't a list, so several
  // values mean a malformed request, not a typo.
  if (values.length !== 1) {
    return { ok: false, error: `needs exactly one value.` };
  }
  return { ok: true, value: values[0] };
}
