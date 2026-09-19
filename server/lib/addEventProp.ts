import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkEvent, isValidEventName } from "@genug/schema-registry";
import { composeRule, parseExample, type PropSpec } from "./createEvent.js";

// Adds one prop to an event that already has traffic — the one shape
// change the cockpit is allowed to make to a live event.
//
// Editing an existing event is otherwise words-only (lib/editEvent.ts):
// every declared prop's schema is a z.strictObject
// (packages/schema-registry/src/loadEvents.ts), so removing a prop, or
// adding a REQUIRED one, makes the whole event start being rejected for
// any sender that has not been redeployed yet — exactly the silent
// traffic-drop the words-only line exists to prevent. A prop added as
// OPTIONAL carries none of that risk: nobody is sending it yet, so an
// absent key is indistinguishable from any row already stored.
//
// This is enforced here, not just in the cockpit form: `spec.optional`
// is never read, so there is no way to reach the unsafe case through
// this function even if a caller's checkbox disagreed.

export type AddPropResult = { ok: true } | { ok: false; error: string };

function failed(error: string): AddPropResult {
  return { ok: false, error };
}

export function addEventProp(
  directory: string,
  eventName: string,
  spec: PropSpec,
): AddPropResult {
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    return failed(
      `${eventName}.json could not be read: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const before = checkEvent(parsed);
  if (!before.ok) {
    return failed(
      `${eventName}.json is not currently loading, so a prop cannot be ` +
        `added to it here. Fix the file itself first: ` +
        `${before.errors.join("; ")}`,
    );
  }

  if (Object.hasOwn(before.event.props, spec.name)) {
    return failed(`"${spec.name}" is already a prop of ${eventName}.`);
  }

  const optionalSpec: PropSpec = { ...spec, optional: true };

  const example = parseExample(optionalSpec);
  if (!example.ok) {
    return failed(`The example for "${spec.name}" ${example.error}`);
  }

  const updated: Record<string, unknown> = {
    ...(parsed as Record<string, unknown>),
    [spec.name]: composeRule(optionalSpec),
    [`${spec.name}_description`]: spec.description,
    [`${spec.name}_example`]: example.value,
  };

  // The same check the loader runs, before anything reaches disk — a
  // prop name colliding with a reserved `_description`/`_example`/`_note`
  // suffix is exactly what this catches and this function does not know
  // to look for on its own.
  const after = checkEvent(updated);
  if (!after.ok) {
    return failed(`Not saved — ${after.errors.join("; ")}`);
  }

  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return { ok: true };
}
