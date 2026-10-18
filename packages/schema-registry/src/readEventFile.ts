import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkEvent, type CheckedEvent } from "./checkEvent.js";

// Reads one event file, parses it and runs the loader's check, for the
// cockpit's edit and add-prop actions (server/lib/editEvent.ts,
// server/lib/addEventProp.ts). A file that wouldn't load is refused
// rather than changed further. `action` is the part of the error message
// that differs between callers (what can't be done).

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
