import { join } from "node:path";
import { contextPath } from "./context.js";
import { appendHistoryEntry, HISTORY_FILE } from "./history.js";
import { logError } from "./logger.js";
import { localDate } from "./timezone.js";

// Adds history entries automatically. `add_history_note` records what a
// person says happened to the site; this records cockpit actions that
// can change the numbers.
//
// There are three: renaming an event, deleting one, and Reset events.
// They leave stored rows that no longer match any event
// (lib/orphanedEvents.ts), so a chart that drops on the 12th may be
// explained here rather than by something on the website. Creating an
// event or editing its wording changes no number, so those aren't logged:
// a log of everything is a log nobody reads.

// Every automatic entry says so in its text. The agent is told the file
// is the owner's own record, so an entry nobody typed must not look like
// one someone did.
const PREFIX = "Recorded automatically: ";

// An entry is limited to 2000 characters (lib/history.ts), and a reset
// can affect more events than fit. So only the biggest few are named and
// the rest are counted, rather than cutting the sentence off.
const MAX_NAMED_EVENTS = 5;

// What the owner typed in the optional "why?" box. The entry marks it as
// their words: the rest of the entry is what the server observed, while
// the reason is someone's claim. It is asked for in the form because
// that is when the reason is known; a week later nobody writes it down.
export interface WithReason {
  reason?: string;
}

export interface RenamedRows extends WithReason {
  // Rows moved to the new name, because the owner asked for it.
  movedRows: number;
  // Rows left under the old name that no event matches any more. This is
  // not always "the rows that weren't moved": after deleting or renaming
  // `page_view`, the built-in stand-in takes that name again, so its rows
  // still match. The caller works this out; this module just writes it
  // down.
  strandedRows: number;
}

export function recordEventRenamed(
  from: string,
  to: string,
  rows: RenamedRows,
  timezone: string,
  directory: string = contextPath,
): void {
  record(
    `the event "${from}" was renamed to "${to}". ${rowsClause(rows)}` +
      given(rows.reason),
    timezone,
    directory,
  );
}

export interface DeletedRows extends WithReason {
  // How many rows the event had collected.
  storedRows: number;
  // How many of those no event matches any more. Zero when the name is
  // still registered afterwards (the stand-in case above).
  strandedRows: number;
}

export function recordEventDeleted(
  name: string,
  rows: DeletedRows,
  timezone: string,
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
    timezone,
    directory,
  );
}

// Mentions each number only when it isn't zero. Saying "these rows no
// longer match anything" about an event that never collected a row
// would give the agent a cause for a drop that never happened.
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

// Missing, empty or only spaces all mean no reason, so the entry never
// ends in an empty "Reason given:".
function given(reason: string | undefined): string {
  const trimmed = reason?.trim();
  return trimmed ? ` Reason given: ${trimmed}` : "";
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// Verb agreement: one event "stays" and "matches", several "stay" and
// "match". Grammar mistakes like "1 stored event stay" make a reader
// trust the rest of the text less.
function verb(n: number, base: "stay" | "match"): string {
  if (n !== 1) return base;
  // Written out rather than adding an "s", because "match" takes "es".
  return base === "match" ? "matches" : "stays";
}

export function recordEventsReset(
  removed: number,
  stranded: { event: string; count: number }[],
  timezone: string,
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
    timezone,
    directory,
  );
}

// Dated today in the site's time zone, like the dates the owner writes
// by hand.
//
// Never throws or reports failure. The caller has already renamed the
// event, so a failed note is only logged; it must not look as if the
// rename failed.
function record(note: string, timezone: string, directory: string): void {
  const entry = {
    from: localDate(new Date(), timezone),
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
