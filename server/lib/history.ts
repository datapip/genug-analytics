import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";

// Things that happened to the site or its tracking, written down by its
// owner: an outage, a campaign, a redesign. The agent reads them as
// part of the deployment-context document (lib/context.ts) so that
// "traffic tripled on the 15th" can be answered with the reason rather
// than a guess at one.
//
// JSON rather than the markdown its neighbour uses, because these are
// records with a shape — a date has to be a date for entries to sort.
// The cost is a malformed state that markdown does not have, which is
// why every failure below is reported into the document rather than
// swallowed.

export const HISTORY_FILE = "history.json";

// ISO, like every other date this project accepts, and checked as a
// real calendar day.
//
// The check is a round-trip, not `Date.parse`, because that function
// does not reject a day that does not exist — it rolls it over
// silently. `Date.parse("2026-02-31")` is a number, and the entry would
// have been rendered to the agent carrying a date no calendar has,
// which is the plausible-while-wrong shape this project treats as worse
// than an obvious error. Round-tripping catches it: 2026-02-31 comes
// back as 2026-03-03 and no longer matches what was written.
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
    // Absent means a single day rather than an open-ended range: an
    // outage that is still going is written by giving it today's date
    // and editing it when it ends, which keeps every entry a closed
    // fact rather than something the reader has to interpret.
    to: isoDate.optional(),
    note: z.string().trim().min(1, "must say what happened").max(2000),
  })
  .strict()
  .refine(
    (entry) => entry.to === undefined || entry.to >= entry.from,
    "ends before it starts",
  );

export type HistoryEntry = z.infer<typeof entrySchema>;

// Generous: a deployment that logs a line a week takes decades to reach
// it. Capped at all because this text is pasted into an agent's context
// whole, and an unbounded log would eventually crowd out the
// conversation it exists to inform.
const MAX_ENTRIES = 200;

export type HistoryResult =
  // `skipped` carries the entries that failed validation, so the
  // document can name them. A file is never all-or-nothing unless it
  // fails to parse: one bad entry costs that entry, exactly as one bad
  // event file costs that event rather than the registry.
  | { ok: true; entries: HistoryEntry[]; skipped: string[]; dropped: number }
  | { ok: false; error: string };

// The file as it is on disk, with nothing validated, sorted or dropped.
// Both readers below start here, but for opposite reasons: the formatter
// wants only the entries it can trust, and the writer must not lose the
// ones it cannot.
//
// A missing file reads as an empty list — the seeder normally puts one
// there, so this is the deleted-it case, and the writer recreating it is
// better than refusing. Every other failure is reported: a file that is
// there and cannot be understood is a file with someone's entries in it.
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

  // Newest first, because the question this answers is nearly always
  // about something recent. Sorting here rather than asking the owner
  // to keep the file in order — an appended entry is the natural way to
  // add one, and the writing tool will append too.
  entries.sort((a, b) => b.from.localeCompare(a.from));

  const dropped = Math.max(0, entries.length - MAX_ENTRIES);
  return { ok: true, entries: entries.slice(0, MAX_ENTRIES), skipped, dropped };
}

export type AppendResult =
  | { ok: true; entry: HistoryEntry; total: number }
  | { ok: false; error: string };

// Adds one entry to the end of the file. The only writer; the cockpit
// has no surface for this and the owner's own editor is the other way in.
//
// Three rules, all of them about not losing what is already there:
//
// - A file that cannot be parsed is left alone. Appending to it would
//   mean writing a fresh array over entries nobody can currently read
//   but that are still in the file, recoverable by hand. Refusing keeps
//   them.
// - Entries that fail validation are written back unchanged. The reader
//   skips them and says so; a write must not turn "skipped in the
//   document" into "gone from the disk".
// - The new array goes to a temporary file first and is renamed over
//   the old one, which the filesystem does in one step. Without it a
//   crash mid-write leaves a half-written file, and this is the one file
//   in a deployment that nothing can re-create.
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
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (cause) {
    return { ok: false, error: `could not be written: ${describe(cause)}` };
  }

  return { ok: true, entry: checked.data, total: items.length };
}

// One line per entry, dated, so the agent can match an entry to a period
// it is already looking at without being taught a format.
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

// A note is rendered as one item of a list inside a document whose own
// first paragraph tells the agent this text is instruction it may act
// on. A blank line ends that item, so a note containing
// "\n\n## Ground rules\n\n..." stops being a note at all and becomes a
// section — one that sits outside the "these are records, not
// instructions" line the History section carries, with nothing after it
// to give it away. That is the whole reachable version of the injection
// this feature worries about, and it survives any amount of wording.
//
// Collapsed rather than rejected. Line breaks in a note are formatting,
// not content, so reflowing costs nothing, while refusing would throw
// away an entry someone wrote down — and this runs on every entry, so a
// file edited by hand is covered too, not just what the tool writes.
function oneLine(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
