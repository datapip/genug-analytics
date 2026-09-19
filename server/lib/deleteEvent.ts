import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { isValidEventName } from "@genug/schema-registry";

// Deletes one event's file from the cockpit's Schema registry card — a
// scoped version of the danger zone's whole-directory Reset. Rows
// already stored under this name are left exactly where Reset leaves
// them: still in the table, no longer matching a registered event, the
// ordinary orphaned-events case lib/orphanedEvents.ts already reports.
//
// Carries no opinion about role tags — an earlier version of this
// function refused to delete any of them, on the theory that the
// traffic would silently miscount as something else. That turned out
// to be wrong for two of the three: the client only ever sends the
// ROLE for `_automaticOutboundClick`/`_automaticFileDownload`, never a
// literal name (see AGENTS.md), so if nothing carries the tag after
// the delete, the next automatic click or download is rejected as
// unknown_event_type — a clean, visible rejection, not a silent
// miscount anywhere.
//
// `_pageView` is the one that still needs care: registry.ts's
// buildRegistry() re-registers the built-in page_view as a stand-in
// when nothing carries the tag, UNLESS the built-in's own name is
// already taken by some other file, in which case buildRegistry()
// throws outright rather than leave a registry with no page-view
// event. Deciding which of those two this delete would trigger means
// asking the real loader, which reads the whole directory — not
// something this directory-scoped function can predict on its own
// without reimplementing buildRegistry() here. So it does not try:
// it deletes and hands the caller a `restore` closure, and
// routes/cockpit.ts's DELETE handler is what actually asks
// reloadEvents() and calls `restore()` if the real loader refuses the
// result — the same "write it, let the checker decide" principle
// lib/editEvent.ts and lib/createEvent.ts use before their own
// writes, just necessarily after this one.

export type DeleteResult =
  | { ok: true; storedCount: number; restore: () => void }
  | { ok: false; error: string };

function failed(error: string): DeleteResult {
  return { ok: false, error };
}

export function deleteEventFile(
  db: Database.Database,
  directory: string,
  eventName: string,
): DeleteResult {
  if (!isValidEventName(eventName)) {
    return failed(
      `"${eventName}" cannot be an event name, so there is no file it ` +
        `could name.`,
    );
  }

  const path = join(directory, `${eventName}.json`);
  if (!existsSync(path)) {
    return failed(`There is no ${eventName}.json in ${directory}.`);
  }

  const original = readFileSync(path, "utf8");
  unlinkSync(path);

  return {
    ok: true,
    storedCount: countStored(db, eventName),
    // Writes back the exact bytes that were here, not a re-serialized
    // JSON.stringify, so a restore is indistinguishable from the
    // delete never having happened.
    restore: () => writeFileSync(path, original, "utf8"),
  };
}

function countStored(db: Database.Database, event: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE event = ?`)
    .get(event) as { count: number };
  return row.count;
}
