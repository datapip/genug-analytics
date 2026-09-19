import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  checkEvent,
  isValidEventName,
  type PropRule,
} from "@genug/schema-registry";

// Applies an edit made in the cockpit to one event file.
//
// Only the words change: the event's name, its description, and each
// prop's description and example. Prop names, types
// and role tags are read back out of the file and written again
// untouched, which is what makes this safe to expose in a browser —
// nothing here can alter whether an incoming event is accepted, so the
// worst a mistake costs is prose an agent reads.
//
// Nothing is written until the whole edited file has passed the same
// checker the loader uses. A file this wrote is a file that loads.

export interface EventEdit {
  // The event's name after the edit. Different from the current name
  // means a rename, which is also a file rename.
  name: string;
  description: string;
  // Keyed by prop name. Every key must already be a prop of this event;
  // the values are the two pieces of prose attached to it. Examples
  // arrive as text because they come from a text input — see
  // parseExample for how a non-string prop's is read back.
  props: Record<string, { description: string; example: string }>;
  // Whether to carry the rows already stored under the old name over to
  // the new one. Ignored unless the name actually changed.
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
  // The event's file is named after it, so an unchecked name here is a
  // path, not a label: PUT /cockpit/events/..%2F..%2Fsecret reaches a
  // file outside EVENTS_PATH, and a rename unlinks it.
  if (!isValidEventName(currentName)) {
    return failed(
      `"${currentName}" cannot be an event name, so there is no file it ` +
        `could name.`,
    );
  }

  if (!isValidEventName(edit.name)) {
    return failed(
      `"${edit.name}" cannot be an event name. The file is named after the ` +
        `event, so a name may only contain lowercase letters, digits and ` +
        `underscores.`,
    );
  }

  const currentPath = join(directory, `${currentName}.json`);
  if (!existsSync(currentPath)) {
    return failed(`There is no ${currentName}.json in ${directory}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(currentPath, "utf8"));
  } catch (cause) {
    return failed(
      `${currentName}.json could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  // A file that does not load has something wrong with it that this
  // editor cannot reach — a bad rule string, a missing example, a
  // malformed tag. Rewriting two of its fields would leave it just as
  // broken while implying it had been fixed.
  const before = checkEvent(parsed);
  if (!before.ok) {
    return failed(
      `${currentName}.json is not currently loading, so it cannot be edited ` +
        `here. Fix the file itself first: ${before.errors.join("; ")}`,
    );
  }

  const updated: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
  };
  updated._description = edit.description;

  for (const [propName, words] of Object.entries(edit.props)) {
    const known = before.event.props[propName];
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

  // The same check the loader runs, before anything reaches disk rather
  // than after — so a rejected edit costs nothing at all, instead of
  // leaving a file the next reload refuses.
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

  // Checked before the write, so declining leaves nothing half-done.
  // Rows under the target name belong to some earlier event of that
  // name — orphaned, since a file of that name would have been caught
  // just above. Merging one event's history into another's is not
  // something a checkbox should do quietly, and nothing can separate
  // them again afterwards.
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

  writeFileSync(targetPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  if (renaming) unlinkSync(currentPath);

  // After the file, never before. A rename that moved the rows and then
  // failed to write would leave every row pointing at a name nothing
  // defines; this way round the worst case is rows left under the old
  // name, which is the ordinary stranded-data case the orphaned-events
  // panel already reports.
  const movedRows =
    renaming && edit.renameStoredEvents
      ? db
          .prepare(`UPDATE events SET event = @to WHERE event = @from`)
          .run({ from: currentName, to: edit.name }).changes
      : 0;

  return { ok: true, name: edit.name, movedRows };
}

function countStored(db: Database.Database, event: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE event = ?`)
    .get(event) as { count: number };
  return row.count;
}

type ParsedExample =
  { ok: true; value: unknown } | { ok: false; error: string };

// Examples come from a text input, and most of them are strings, where
// the text is the value. For anything else the text is read as JSON —
// asking someone to type quotes around a page title to edit it would be
// absurd, and there is no way to tell 49.9 from "49.9" without knowing
// the declared type.
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
