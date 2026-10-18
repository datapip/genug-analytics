import {
  checkEvent,
  isValidEventName,
  readLoadableEventFile,
} from "@genug/schema-registry";
import { composeRule, parseExample, type PropSpec } from "./createEvent.js";
import { writeFileAtomic } from "./atomicWrite.js";

// Adds one optional prop to an event that may already be receiving
// traffic. This is the only change to an event's props the cockpit can
// make; otherwise it edits only the wording (lib/editEvent.ts).
//
// Why only optional: each event's props are validated strictly
// (packages/schema-registry/src/loadEvents.ts). Removing a prop, or
// adding a required one, would make every request from a site that
// hasn't been updated fail validation, and those events would be lost.
// An optional prop that nobody sends yet changes nothing for them.
//
// The function always makes the prop optional and ignores
// `spec.optional`, so a caller can't add a required one by mistake.

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

  const loaded = readLoadableEventFile(
    directory,
    eventName,
    "a prop cannot be added to it here.",
  );
  if (!loaded.ok) return failed(loaded.error);
  const { path, parsed, event: before } = loaded;

  if (Object.hasOwn(before.props, spec.name)) {
    return failed(`"${spec.name}" is already a prop of ${eventName}.`);
  }

  const optionalSpec: PropSpec = { ...spec, optional: true };

  const example = parseExample(optionalSpec);
  if (!example.ok) {
    return failed(`The example for "${spec.name}" ${example.error}`);
  }

  const updated: Record<string, unknown> = {
    ...parsed,
    [spec.name]: composeRule(optionalSpec),
    [`${spec.name}_description`]: spec.description,
    [`${spec.name}_example`]: example.value,
  };

  // Run the loader's own check before writing to disk. It catches, for
  // example, a prop name that clashes with the reserved
  // `_description`/`_example`/`_note` suffixes.
  const after = checkEvent(updated);
  if (!after.ok) {
    return failed(`Not saved — ${after.errors.join("; ")}`);
  }

  writeFileAtomic(path, `${JSON.stringify(updated, null, 2)}\n`);
  return { ok: true };
}
