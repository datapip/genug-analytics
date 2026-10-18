import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { isValidEventName } from "@genug/schema-registry";
import { countStored } from "./events.js";
import { writeFileAtomic } from "./atomicWrite.js";

// Deletes one event's file (the cockpit's delete button). Rows already
// stored under its name stay in the database and become orphaned rows,
// which lib/orphanedEvents.ts reports.
//
// Events with role tags may be deleted too. The client sends a role, not
// a name, for automatic outbound clicks and file downloads (see
// AGENTS.md). If no event has that role any more, the next automatic
// click is rejected as unknown_event_type: visible, not a silent
// miscount.
//
// The page-view event needs care. If no event has the `_pageView` tag,
// buildRegistry() (registry.ts) registers the built-in page_view as a
// stand-in, but it throws if another file already uses that name. Only
// the full loader can tell which will happen, so this function doesn't
// guess: it deletes and returns a `restore` function. The DELETE handler
// in routes/cockpit/events.ts reloads the events and calls `restore()`
// if the loader refuses the result.

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
    // Write back the exact original bytes, not re-serialized JSON, so the
    // file is as if it had never been deleted.
    restore: () => writeFileAtomic(path, original),
  };
}
