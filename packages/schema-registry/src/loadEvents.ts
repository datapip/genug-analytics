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

// Reads a directory of event files and turns it into a registry. One
// file per event, named for the event: newsletter_signup.json defines
// newsletter_signup. There is deliberately no `_name` key — a name and
// the file holding it are two places to spell the same thing, and they
// drift.
//
// Never throws on a bad file. Errors come back alongside whatever did
// load, so the caller can decide: a file baked into the image crashes
// startup, a file dropped on a volume is skipped and reported.
//
// One directory is the whole registry. Nothing is layered on top of
// anything, so there is no precedence to reason about — see
// seedEvents.ts for how the volume comes to hold the built-ins.

export interface PropMetadata {
  description: string;
  example: PropScalar | PropScalar[];
  // Declared type, whether the key may be omitted, and whether it holds
  // several values rather than one. An agent reading the
  // schema-registry resource would otherwise have to guess all three
  // from `typeof example`.
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
  // Strict: unrecognized prop keys are rejected, not silently stripped —
  // every prop an event sends must have a registry entry.
  schema: z.ZodType<Record<string, unknown>>;
}

export interface SchemaFileError {
  file: string;
  messages: string[];
  // True when `file` names the events directory rather than an event
  // file in it — the volume could not be prepared, so nothing was
  // rejected and everything is being read from the image instead. The
  // cockpit says so under its own heading, because "N event files were
  // rejected" describes something else entirely.
  directory?: true;
}

export interface LoadedEvents {
  registry: Record<string, EventDefinition>;
  errors: SchemaFileError[];
}

const EVENT_NAME_PATTERN = /^[a-z0-9_]+$/;

// The filename is the event name, so the two constraints are one. Kept
// here beside the loader that enforces it, and exported because the
// cockpit has to reject a bad name before writing a file rather than
// after failing to load it.
//
// Lowercase only, so "Signup" and "signup" can never both be registered
// and split one action's count across two names. routes/events.ts folds
// an incoming event name to lowercase before matching it here, so a
// stray-case track() call still resolves instead of being rejected over
// nothing but casing.
export function isValidEventName(name: string): boolean {
  return EVENT_NAME_PATTERN.test(name) && name.length <= MAX_EVENT_NAME_LENGTH;
}

// The role tags, as they appear on a loaded definition. Spelled out
// rather than imported from registry.ts's EventRoleTag, because
// registry.ts imports this module.
const ROLE_TAGS: readonly EventRole[] = [
  "pageView",
  "outboundClick",
  "fileDownload",
];

export function loadEvents(directory: string): LoadedEvents {
  const registry: Record<string, EventDefinition> = {};
  const errors: SchemaFileError[] = [];
  // Which event has already claimed each role. Two files carrying one
  // tag is not merely wrong, it stops the server: resolveTaggedEvent
  // throws on a tie rather than picking a winner, and the registry is
  // built at import.
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

  // Sorted so the registry's order doesn't depend on the filesystem —
  // it decides the order events appear in the MCP resource and the
  // cockpit.
  const files = entries.filter((name) => name.endsWith(".json")).sort();

  for (const file of files) {
    const name = file.slice(0, -".json".length);

    if (!isValidEventName(name)) {
      errors.push({
        file,
        messages: [
          `"${name}" is not a usable event name — the filename is the event ` +
            `name, so it may only contain lowercase letters, digits and ` +
            `underscores, and be at most ${MAX_EVENT_NAME_LENGTH} characters`,
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
  // An empty array is accepted: a page with no tags is not an error,
  // and json_each simply contributes no rows for it. Only the declared
  // example has to be non-empty (see checkEvent).
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

// Formats a file's errors for a human: a startup crash message, or a
// line in the cockpit. One file per block, one problem per line.
export function formatSchemaErrors(errors: readonly SchemaFileError[]): string {
  return errors
    .map(({ file, messages }) =>
      messages.map((message) => `  ${file}: ${message}`).join("\n"),
    )
    .join("\n");
}
