import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MAX_EVENT_NAME_LENGTH } from "./envelope.js";
import {
  MAX_PROP_LIST_LENGTH,
  type PropRule,
  type PropTypeName,
} from "./parseRule.js";
import {
  checkEvent,
  ROLE_TAG_KEYS,
  type CheckedProp,
  type EventRole,
  type PropScalar,
} from "./checkEvent.js";

// Reads a folder of event files and builds a registry from it. One file
// per event, named after it: newsletter_signup.json defines
// newsletter_signup. There is no `_name` key, so the name can't differ
// from the file name.
//
// Never throws on a bad file. Errors are returned together with what did
// load, and the caller decides: a built-in file stops startup, a file on
// the volume is skipped and reported.
//
// One folder is the whole registry, so there is no order of precedence
// to think about. See seedEvents.ts for how the built-ins get onto the
// volume.

export interface PropMetadata {
  description: string;
  example: PropScalar | PropScalar[];
  // The declared type, whether the prop may be left out, and whether it
  // holds a list of values, so the agent doesn't have to guess them from
  // the example.
  type: PropTypeName;
  required: boolean;
  list: boolean;
}

export interface EventDefinition {
  description: string;
  props: Record<string, PropMetadata>;
  pageView: boolean;
  outboundClick: boolean;
  fileDownload: boolean;
  conversion: boolean;
  // Strict: unknown prop names are rejected, not silently dropped. Every
  // prop an event sends must be declared.
  schema: z.ZodType<Record<string, unknown>>;
}

export interface SchemaFileError {
  file: string;
  messages: string[];
  // True when `file` is the events folder rather than a file in it: the
  // volume couldn't be prepared, so the events are read from the image.
  // Nothing was rejected, so the cockpit shows it under its own heading.
  directory?: true;
}

export interface LoadedEvents {
  registry: Record<string, EventDefinition>;
  errors: SchemaFileError[];
}

const EVENT_NAME_PATTERN = /^[a-z0-9_]+$/;

// The file name is the event name, so this rule covers both. Exported so
// the cockpit can refuse a bad name before writing a file.
//
// Lowercase only, so "Signup" and "signup" can't both exist and split one
// action's count. routes/events.ts lowercases incoming names, so a
// track() call with other casing still works.
//
// The pattern alone would allow names every JavaScript object already
// has. The registry is an object keyed by name, so a file called
// __proto__.json would replace its prototype instead of adding an event,
// and the event would silently not exist. Those names are refused.
export const RESERVED_EVENT_NAMES: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
];

export function isValidEventName(name: string): boolean {
  return (
    EVENT_NAME_PATTERN.test(name) &&
    name.length <= MAX_EVENT_NAME_LENGTH &&
    !RESERVED_EVENT_NAMES.includes(name)
  );
}

// The rule in words, for error messages.
export const EVENT_NAME_RULE =
  "a name may only contain lowercase letters, digits and underscores, " +
  `be at most ${MAX_EVENT_NAME_LENGTH} characters, and not be ` +
  RESERVED_EVENT_NAMES.join(", ");

// The role tags as they appear on a loaded definition. Written out here
// instead of imported from registry.ts, because registry.ts imports this
// module.
const ROLE_TAGS: readonly EventRole[] = [
  "pageView",
  "outboundClick",
  "fileDownload",
];

export function loadEvents(directory: string): LoadedEvents {
  const registry: Record<string, EventDefinition> = {};
  const errors: SchemaFileError[] = [];
  // Which event already has each role. Two files with the same tag would
  // stop the server (resolveTaggedEvent throws rather than picking one),
  // so the second one is skipped.
  const tagHolders = new Map<EventRole, string>();

  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (cause) {
    return {
      registry,
      errors: [
        {
          file: directory,
          messages: [
            `could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
          ],
        },
      ],
    };
  }

  // Sorted, so the order (as shown in the MCP resource and the cockpit)
  // doesn't depend on the filesystem.
  const files = entries.filter((name) => name.endsWith(".json")).sort();

  for (const file of files) {
    const name = file.slice(0, -".json".length);

    if (!isValidEventName(name)) {
      errors.push({
        file,
        messages: [
          `"${name}" is not a usable event name — the filename is the event ` +
            `name, so ${EVENT_NAME_RULE}`,
        ],
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(directory, file), "utf8"));
    } catch (cause) {
      errors.push({
        file,
        messages: [
          `is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        ],
      });
      continue;
    }

    const checked = checkEvent(parsed);
    if (!checked.ok) {
      errors.push({ file, messages: checked.errors });
      continue;
    }

    const taken = ROLE_TAGS.filter(
      (tag) => checked.event[tag] && tagHolders.has(tag),
    );
    if (taken.length > 0) {
      errors.push({
        file,
        messages: taken.map(
          (tag) =>
            `claims "${ROLE_TAG_KEYS[tag]}": true, which ` +
            `"${tagHolders.get(tag)}" already carries — only one event may ` +
            `fill each role, so this file has been ignored. Remove the tag ` +
            `from whichever of the two should not have it.`,
        ),
      });
      continue;
    }

    const shape: Record<string, z.ZodType> = {};
    const props: Record<string, PropMetadata> = {};
    for (const [propName, prop] of Object.entries(checked.event.props)) {
      shape[propName] = zodForRule(prop.rule);
      props[propName] = metadataFor(prop);
    }

    registry[name] = {
      description: checked.event.description,
      props,
      pageView: checked.event.pageView,
      outboundClick: checked.event.outboundClick,
      fileDownload: checked.event.fileDownload,
      conversion: checked.event.conversion,
      schema: z.strictObject(shape),
    };

    for (const tag of ROLE_TAGS) {
      if (checked.event[tag]) tagHolders.set(tag, name);
    }
  }

  return { registry, errors };
}

function zodForRule(rule: PropRule): z.ZodType {
  const element =
    rule.type === "string"
      ? z.string().max(rule.maxLength)
      : rule.type === "number"
        ? z.number()
        : z.boolean();
  // An empty list is fine: a page without tags isn't an error. Only
  // the example must not be empty (see checkEvent).
  const base = rule.list ? z.array(element).max(MAX_PROP_LIST_LENGTH) : element;
  return rule.required ? base : base.optional();
}

function metadataFor(prop: CheckedProp): PropMetadata {
  return {
    description: prop.description,
    example: prop.example,
    type: prop.rule.type,
    required: prop.rule.required,
    list: prop.rule.list,
  };
}

// Formats file errors for people, for the startup error or the cockpit:
// one block per file, one problem per line.
export function formatSchemaErrors(errors: readonly SchemaFileError[]): string {
  return errors
    .map(({ file, messages }) =>
      messages.map((message) => `  ${file}: ${message}`).join("\n"),
    )
    .join("\n");
}
