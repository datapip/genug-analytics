import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  checkEvent,
  EVENT_NAME_RULE,
  isValidEventName,
  readLoadableEventFile,
  type PropRule,
} from "@genug/schema-registry";
import { countStored } from "./events.js";
import { writeFileAtomic } from "./atomicWrite.js";

// Saves an edit made in the cockpit to one event file.
//
// Only the wording can change: the event's name, its description, and
// each prop's description and example. Prop names, types and role tags
// are copied from the file unchanged. That makes it safe to offer in a
// browser: nothing here can change whether an incoming event is
// accepted, so a mistake only affects text the agent reads.
//
// Nothing is written until the edited file passes the loader's own
// check, so every file this writes will load.

export interface EventEdit {
  // The event's name after the edit. If it differs from the current
  // name, the event (and its file) is renamed.
  name: string;
  description: string;
  // Keyed by prop name; every key must be an existing prop of this
  // event. Examples arrive as text from a text input; parseExample
  // converts them for props that aren't strings.
  props: Record<string, { description: string; example: string }>;
  // Whether to move the rows stored under the old name to the new one.
  // Ignored unless the name changed.
  renameStoredEvents: boolean;
}

export type EditResult =
  { ok: true; name: string; movedRows: number } | { ok: false; error: string };

function failed(error: string): EditResult {
  return { ok: false, error };
}

export function editEventFile(
  db: Database.Database,
  directory: string,
  currentName: string,
  edit: EventEdit,
): EditResult {
  // The file is named after the event, so the name must be checked: an
  // unchecked name like ..%2F..%2Fsecret would point at a file outside
  // EVENTS_PATH, and a rename would delete it.
  if (!isValidEventName(currentName)) {
    return failed(
      `"${currentName}" cannot be an event name, so there is no file it ` +
        `could name.`,
    );
  }

  if (!isValidEventName(edit.name)) {
    return failed(
      `"${edit.name}" cannot be an event name. The file is named after ` +
        `the event, so ${EVENT_NAME_RULE}.`,
    );
  }

  // A file that doesn't load has a problem this editor can't fix (a bad
  // rule string, a missing example, a malformed tag). Saving new wording
  // would leave it just as broken while looking fixed.
  const loaded = readLoadableEventFile(
    directory,
    currentName,
    "it cannot be edited here.",
  );
  if (!loaded.ok) return failed(loaded.error);
  const { path: currentPath, parsed, event: before } = loaded;

  const updated: Record<string, unknown> = { ...parsed };
  updated._description = edit.description;

  for (const [propName, words] of Object.entries(edit.props)) {
    const known = before.props[propName];
    if (known === undefined) {
      return failed(
        `"${propName}" is not a prop of ${currentName}. Props can be ` +
          `described here, but adding or removing one means editing the ` +
          `file — it changes which events are accepted.`,
      );
    }

    const example = parseExample(words.example, known.rule);
    if (!example.ok) {
      return failed(`The example for "${propName}" ${example.error}`);
    }

    updated[`${propName}_description`] = words.description;
    updated[`${propName}_example`] = example.value;
  }

  // Run the loader's check before writing, so a rejected edit changes
  // nothing instead of leaving a file the next reload refuses.
  const after = checkEvent(updated);
  if (!after.ok) {
    return failed(`Not saved — ${after.errors.join("; ")}`);
  }

  const renaming = edit.name !== currentName;
  const targetPath = join(directory, `${edit.name}.json`);
  if (renaming && existsSync(targetPath)) {
    return failed(
      `${edit.name}.json already exists. Renaming onto it would replace an ` +
        `event that is already defined.`,
    );
  }

  // Checked before writing, so refusing leaves nothing half-done. Rows
  // already under the new name belong to an earlier event of that name
  // (orphaned rows). Moving more rows onto them would merge two events'
  // history for good, which a checkbox shouldn't do.
  if (renaming && edit.renameStoredEvents) {
    const existing = countStored(db, edit.name);
    if (existing > 0) {
      return failed(
        `${existing} events are already stored under "${edit.name}", left ` +
          `behind by an earlier rename. Moving this event's history onto ` +
          `them would merge the two permanently. Save without moving the ` +
          `stored events, then move them yourself if that is what you want.`,
      );
    }
  }

  writeFileAtomic(targetPath, `${JSON.stringify(updated, null, 2)}\n`);
  if (renaming) unlinkSync(currentPath);

  // Move the rows after writing the file, never before. If the file
  // write failed after the rows moved, every row would have a name no
  // event defines. This way the worst case is rows left under the old
  // name, which the orphaned-events panel reports.
  const movedRows =
    renaming && edit.renameStoredEvents
      ? db
          .prepare(`UPDATE events SET event = @to WHERE event = @from`)
          .run({ from: currentName, to: edit.name }).changes
      : 0;

  return { ok: true, name: edit.name, movedRows };
}

type ParsedExample =
  { ok: true; value: unknown } | { ok: false; error: string };

// Examples come from a text input. For a string prop the text is the
// value, so nobody has to type quotes around a page title. For any other
// type the text is read as JSON: only the declared type says whether
// 49.9 is a number or a string.
function parseExample(text: string, rule: PropRule): ParsedExample {
  if (rule.type === "string" && !rule.list) return { ok: true, value: text };

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      error: `has to be written as JSON here, because this prop holds ${shape(rule)}.`,
    };
  }
}

function shape(rule: PropRule): string {
  if (rule.list) {
    return rule.type === "string"
      ? `a list of text values, like ["news", "product"]`
      : rule.type === "number"
        ? `a list of numbers, like [1, 2, 3]`
        : `a list of true/false values, like [true, false]`;
  }
  return rule.type === "number" ? `a number, like 49.9` : `true or false`;
}
