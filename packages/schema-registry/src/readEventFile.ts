import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkEvent, type CheckedEvent } from "./checkEvent.js";

// The cockpit's edit and add-prop writes (server/lib/editEvent.ts,
// server/lib/addEventProp.ts) both start the same way: read one event's
// file, parse it, and run it through the same checker the loader uses,
// so a write is refused on a file that would not load anyway rather
// than being layered onto something already broken. `action` is the
// one sentence that differs between callers — what exactly can't be
// done here — spliced into the same message shape as the rest.

export type LoadedEventFile =
  | {
      ok: true;
      path: string;
      parsed: Record<string, unknown>;
      event: CheckedEvent;
    }
  | { ok: false; error: string };

export function readLoadableEventFile(
  directory: string,
  eventName: string,
  action: string,
): LoadedEventFile {
  const path = join(directory, `${eventName}.json`);
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `There is no ${eventName}.json in ${directory}.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return {
      ok: false,
      error:
        `${eventName}.json could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const checked = checkEvent(parsed);
  if (!checked.ok) {
    return {
      ok: false,
      error:
        `${eventName}.json is not currently loading, so ${action} ` +
        `Fix the file itself first: ${checked.errors.join("; ")}`,
    };
  }

  return {
    ok: true,
    path,
    parsed: parsed as Record<string, unknown>,
    event: checked.event,
  };
}
