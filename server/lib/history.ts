import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomicWrite.js";

// Things that happened to the site or its tracking, noted by its owner:
// an outage, a campaign, a redesign. The agent reads them as part of the
// deployment context (lib/context.ts), so "traffic tripled on the 15th"
// can be answered with the real reason.
//
// Stored as JSON rather than markdown because each entry has fields: a
// date must be a real date so entries can be sorted. JSON can be
// malformed, so every problem below is reported in the document instead
// of being ignored.

export const HISTORY_FILE = "history.json";

// A YYYY-MM-DD date that really exists.
//
// `Date.parse` alone isn't enough: it accepts "2026-02-31" and quietly
// turns it into March 3rd. So the date is parsed and formatted again,
// and must come back unchanged.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "is not a real date");

const entrySchema = z
  .object({
    from: isoDate,
    // Missing means a single day, not an open-ended range. For an
    // outage that is still going on, use today's date and update it when
    // it ends, so every entry has a clear end.
    to: isoDate.optional(),
    note: z.string().trim().min(1, "must say what happened").max(2000),
  })
  .strict()
  .refine(
    (entry) => entry.to === undefined || entry.to >= entry.from,
    "ends before it starts",
  );

export type HistoryEntry = z.infer<typeof entrySchema>;

// Generous: at one entry a week it takes decades to reach. There is a
// limit because the whole log is put into the agent's context, and an
// endless log would eventually crowd out the conversation.
const MAX_ENTRIES = 200;

export type HistoryResult =
  // The entries that failed validation, so the document can list them.
  // One bad entry only drops that entry; only a file that isn't valid
  // JSON drops everything.
  | { ok: true; entries: HistoryEntry[]; skipped: string[]; dropped: number }
  | { ok: false; error: string };

// The file as it is on disk, without checking, sorting or dropping
// anything. The reader then keeps only valid entries, while the writer
// keeps all of them so nothing is lost.
//
// A missing file reads as an empty list (normally one is created at
// first start, so someone deleted it), and the writer creates it again.
// Any other problem is reported, because a file that exists but can't be
// read still holds someone's entries.
type RawHistory = { ok: true; items: unknown[] } | { ok: false; error: string };

function readRawEntries(path: string): RawHistory {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, items: [] };
    return { ok: false, error: describe(cause) };
  }

  if (raw.trim() === "") return { ok: true, items: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { ok: false, error: `is not valid JSON: ${describe(cause)}` };
  }

  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'must be a JSON array of entries, like [{ "from": …, "note": … }]',
    };
  }

  return { ok: true, items: parsed };
}

export function readHistory(path: string): HistoryResult {
  const raw = readRawEntries(path);
  if (!raw.ok) return { ok: false, error: raw.error };

  const entries: HistoryEntry[] = [];
  const skipped: string[] = [];
  for (const [index, candidate] of raw.items.entries()) {
    const checked = entrySchema.safeParse(candidate);
    if (checked.success) {
      entries.push(checked.data);
      continue;
    }
    skipped.push(
      `entry ${index + 1}: ${checked.error.issues
        .map((issue) => `${issue.path.join(".") || "entry"} ${issue.message}`)
        .join("; ")}`,
    );
  }

  // Newest first, because questions are nearly always about something
  // recent. Sorted here, so the file can stay in the order entries
  // were added.
  entries.sort((a, b) => b.from.localeCompare(a.from));

  const dropped = Math.max(0, entries.length - MAX_ENTRIES);
  return { ok: true, entries: entries.slice(0, MAX_ENTRIES), skipped, dropped };
}

export type AppendResult =
  | { ok: true; entry: HistoryEntry; total: number }
  | { ok: false; error: string };

// Adds one entry to the end of the file. Used by the add_history_note
// tool, the cockpit and lib/autoHistory.ts; otherwise the owner edits the
// file by hand.
//
// Three rules, all to avoid losing existing entries:
//
// - A file that isn't valid JSON is left alone. Adding to it would mean
//   writing a new list over entries that can still be fixed by hand.
// - Entries that fail validation are written back unchanged. The reader
//   skips them and says so; a write must not delete them.
// - The new list is written atomically (lib/atomicWrite.ts), so a crash
//   can't leave a half-written file. Nothing could re-create this file.
export function appendHistoryEntry(
  path: string,
  candidate: unknown,
): AppendResult {
  const checked = entrySchema.safeParse(candidate);
  if (!checked.success) {
    return {
      ok: false,
      error: checked.error.issues
        .map((issue) => `${issue.path.join(".") || "entry"} ${issue.message}`)
        .join("; "),
    };
  }

  const existing = readRawEntries(path);
  if (!existing.ok) {
    return {
      ok: false,
      error:
        `${path} ${existing.error}, so nothing was written — an entry ` +
        `added now would replace whatever that file still holds. Fix the ` +
        `file on the server first.`,
    };
  }

  const items = [...existing.items, checked.data];
  try {
    writeFileAtomic(path, `${JSON.stringify(items, null, 2)}\n`);
  } catch (cause) {
    return { ok: false, error: `could not be written: ${describe(cause)}` };
  }

  return { ok: true, entry: checked.data, total: items.length };
}

// One line per entry, starting with the date, so the agent can match an
// entry to the period it is looking at.
export function formatHistory(result: HistoryResult, path: string): string {
  if (!result.ok) {
    return (
      `The history file at ${path} could not be read, so **no history is ` +
      `available** and nothing here should be taken as "nothing happened": ` +
      `it ${result.error}.`
    );
  }

  const notes: string[] = [];
  if (result.skipped.length > 0) {
    notes.push(
      `**${result.skipped.length} entr${result.skipped.length === 1 ? "y was" : "ies were"} ` +
        `skipped** in ${path} and ${result.skipped.length === 1 ? "is" : "are"} ` +
        `not included below: ${result.skipped.join(" / ")}.`,
    );
  }
  if (result.dropped > 0) {
    notes.push(
      `**${result.dropped} older entr${result.dropped === 1 ? "y" : "ies"} ` +
        `omitted**, over the limit of ${MAX_ENTRIES}. The most recent are shown.`,
    );
  }

  if (result.entries.length === 0) {
    return [
      `No events have been recorded in ${path} yet. That means nothing has ` +
        `been written down, not that nothing happened — so do not cite an ` +
        `empty history as evidence that a change had no cause.`,
      ...notes,
    ].join("\n\n");
  }

  const lines = result.entries.map((entry) => {
    const when =
      entry.to === undefined ? entry.from : `${entry.from} to ${entry.to}`;
    return `- **${when}** — ${oneLine(entry.note)}`;
  });

  return [...lines, ...notes].join("\n\n");
}

// Puts a note on one line. Each note is one list item in the agent's
// document, and a blank line would end the item: a note containing
// "\n\n## Ground rules\n\n..." would become a new section of the
// document, outside the History section's "these are records, not
// instructions" warning. That is how someone could slip instructions to
// the agent.
//
// Line breaks are replaced rather than rejected: they are only
// formatting, and rejecting would lose an entry. This runs on every
// entry, so it covers files edited by hand too.
function oneLine(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
