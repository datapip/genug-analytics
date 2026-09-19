import { join } from "node:path";
import { contextPath } from "./context.js";
import { appendHistoryEntry, HISTORY_FILE } from "./history.js";
import { logError } from "./logger.js";

// The history log's second writer. `add_history_note` records what a
// person says happened to the site; this records the handful of things
// the cockpit itself does that can move a number.
//
// Only three: renaming an event, deleting one, and Reset events. Those
// strand stored rows — the rows keep counting toward totals while
// matching no question asked by name (lib/orphanedEvents.ts) — so a
// chart that drops on the 12th may have a cause in this file rather
// than on the website. Creating an event and editing its wording change
// no number, and are deliberately not logged: a log of everything is a
// log nobody reads.
//
// This is also what replaced the `_createdAt`/`_updatedAt` fields that
// were planned for each event definition. Those would have been written
// by the cockpit only, so a file edited by hand over SSH — an ordinary
// thing to do here — would have carried a date that was quietly wrong.
// A dated line saying what happened is both true and more use than a
// date saying only when.

// Every entry says so, in the text, where the agent reading the
// document sees it. The file is described to the agent as the owner's
// own record, and most of it is; an entry nobody typed should not be
// able to pass for one that someone did.
const PREFIX = "Recorded automatically: ";

// An entry's note is capped at 2000 characters (lib/history.ts), and a
// reset can strand more events than fit. Naming the biggest few and
// counting the rest keeps the entry inside the cap without the cap
// deciding where the sentence stops.
const MAX_NAMED_EVENTS = 5;

// What the owner typed in the optional "why?" box, if they typed
// anything. Their words, not the server's, so the entry says whose they
// are — the rest of the sentence is a fact this code observed, and a
// reason is a claim someone is making.
//
// It is also the moment the reason is actually known: a week later
// nobody writes the note, which is the whole argument for asking in the
// form rather than hoping for a separate history entry afterwards.
export interface WithReason {
  reason?: string;
}

export interface RenamedRows extends WithReason {
  // Carried to the new name, because the owner asked for it.
  movedRows: number;
  // Left under the old name with nothing able to ask about them. Not
  // simply "the ones that did not move": deleting or renaming away from
  // `page_view` hands that name back to the built-in stand-in, and rows
  // under a name that is registered again are not stranded at all. The
  // caller works that out; this module only writes down what it is told.
  strandedRows: number;
}

export function recordEventRenamed(
  from: string,
  to: string,
  rows: RenamedRows,
  directory: string = contextPath,
): void {
  record(
    `the event "${from}" was renamed to "${to}". ${rowsClause(rows)}` +
      given(rows.reason),
    directory,
  );
}

export interface DeletedRows extends WithReason {
  // What the event had collected, whatever became of it.
  storedRows: number;
  // How many of those nothing can ask about any more — zero when the
  // name is still registered afterwards (the stand-in case above).
  strandedRows: number;
}

export function recordEventDeleted(
  name: string,
  rows: DeletedRows,
  directory: string = contextPath,
): void {
  const stored =
    rows.strandedRows > 0
      ? `${count(rows.strandedRows, "stored event")} ${verb(rows.strandedRows, "stay")} in the database and no longer ${verb(rows.strandedRows, "match")} a question asked by name.`
      : rows.storedRows > 0
        ? `Its ${count(rows.storedRows, "stored event")} still ${verb(rows.storedRows, "match")} a registered event of the same name, so nothing was stranded.`
        : `It had no stored events.`;

  record(
    `the event "${name}" was deleted. ${stored}` + given(rows.reason),
    directory,
  );
}

// Both numbers, when both happened, and neither sentence when neither
// did. The failure worth avoiding is a confident "these rows no longer
// match anything" about an event that never collected a row — a cause
// invented for a drop that did not happen, in the file that exists to
// stop exactly that.
function rowsClause(rows: RenamedRows): string {
  const parts: string[] = [];
  if (rows.movedRows > 0) {
    parts.push(
      `${count(rows.movedRows, "stored event")} moved to the new name`,
    );
  }
  if (rows.strandedRows > 0) {
    parts.push(
      `${count(rows.strandedRows, "stored event")} stayed under the old name and no longer ${verb(rows.strandedRows, "match")} a question asked by name`,
    );
  }
  if (parts.length === 0) return "It had no stored events.";
  return `${parts.join(", and ")}.`;
}

// Absent, empty, or whitespace only: all the same thing, and none of
// them should produce a dangling "Reason given:" with nothing after it.
function given(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed ? ` Reason given: ${trimmed}` : "";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// The other half of counting: one event *stays* and *matches*, several
// *stay* and *match*. Worth the four lines — these sentences are read
// by a model that is being asked to explain a number, and "1 stored
// event stay" is the kind of wrongness that makes a reader discount
// everything around it.
function verb(n: number, base: "stay" | "match"): string {
  if (n !== 1) return base;
  // Spelled out rather than built by adding an "s": "match" takes "es",
  // and a rule with one exception in a set of two is just two words.
  return base === "match" ? "matches" : "stays";
}

export function recordEventsReset(
  removed: number,
  stranded: { event: string; count: number }[],
  directory: string = contextPath,
): void {
  const named = stranded
    .slice(0, MAX_NAMED_EVENTS)
    .map((row) => `${row.event} (${row.count})`)
    .join(", ");
  const rest = stranded.length - MAX_NAMED_EVENTS;

  const consequence =
    stranded.length === 0
      ? `No stored events were stranded.`
      : `Stored events that now match no registered event: ${named}` +
        `${rest > 0 ? `, and ${rest} more` : ""}.`;

  record(
    `the events directory was reset to the built-ins, replacing ` +
      `${removed} ${removed === 1 ? "file" : "files"}. ${consequence}`,
    directory,
  );
}

// Dated today, in UTC, like every other date this project stores.
//
// Never throws, and never reports failure to the caller. The caller has
// already renamed the event: a note that could not be written is worth
// a line in the log an operator can read, not an error telling someone
// their rename failed when it did not.
function record(note: string, directory: string): void {
  const entry = {
    from: new Date().toISOString().slice(0, 10),
    note: `${PREFIX}${note}`,
  };

  const result = appendHistoryEntry(join(directory, HISTORY_FILE), entry);
  if (!result.ok) {
    logError(
      "Could not write a registry change to the history log — the change itself was made",
      result.error,
      { note: entry.note },
    );
  }
}
