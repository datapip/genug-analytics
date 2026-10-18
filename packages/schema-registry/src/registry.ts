import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_TAG_KEYS } from "./checkEvent.js";
import {
  loadEvents,
  formatSchemaErrors,
  type EventDefinition,
  type PropMetadata,
  type SchemaFileError,
} from "./loadEvents.js";
import { seedEvents } from "./seedEvents.js";

// The built-in events that ship with the image, one JSON file each, in
// packages/schema-registry/events/. Found relative to this file, not the
// working directory, which may be anywhere.
const BUILT_IN_EVENTS_DIR = fileURLToPath(
  new URL("../events", import.meta.url),
);

const image = loadEvents(BUILT_IN_EVENTS_DIR);

// A broken built-in file is a developer mistake, so it stops the server
// instead of being skipped: it should never get as far as collecting
// data.
//
// Files on the volume are handled the other way on purpose: they were
// edited by hand on a live server or written by the cockpit, and one
// typo must not stop collection for every other event.
if (image.errors.length > 0) {
  throw new Error(
    `Invalid event schema files in ${BUILT_IN_EVENTS_DIR}:
` + formatSchemaErrors(image.errors),
  );
}

// The deployment's own events, on the persistent volume next to the
// database, so a stock image plus a volume is a complete customised
// setup. Can be changed with EVENTS_PATH (for local development outside
// Docker, like DB_PATH).
//
// Reading an environment variable inside this package is a little
// unusual, but the alternative (the server creating the registry and
// passing it to every user) would be a big change for no benefit.
export const eventsPath: string = process.env.EVENTS_PATH ?? "/data/events";

// Just `string`: events are read from JSON files when the server starts,
// so the compiler can't know their names (see docs/decisions.md). Event
// names arrive from the network as any string and are checked against
// the registry at runtime anyway.
export type EventType = string;

// The role tags an event can have, written in the JSON files as
// `_pageView`, `_automaticOutboundClick` and `_automaticFileDownload`
// (checkEvent.ts maps the keys to these names and explains why they
// differ). Each answers "which event means X in this deployment?", so no
// code needs to assume a fixed event name.
export type EventRoleTag = "pageView" | "outboundClick" | "fileDownload";

// `registry` is a parameter so tests can pass a small made-up registry,
// for example to test the error when two events have the same tag.
export function resolveTaggedEvent(
  registry: Record<string, Partial<Record<EventRoleTag, boolean>>>,
  tag: EventRoleTag,
): string | undefined {
  const tagged = Object.entries(registry).filter(([, def]) => def[tag]);
  if (tagged.length > 1) {
    throw new Error(
      `Multiple events are tagged ${tag}: true (${tagged
        .map(([name]) => name)
        .join(", ")}) — only one event can carry each role tag.`,
    );
  }
  return tagged[0]?.[0];
}

interface BuiltRegistry {
  registry: Record<string, EventDefinition>;
  errors: SchemaFileError[];
  pageViewEventType: EventType;
  roleEventNames: Readonly<Partial<Record<EventRoleTag, string>>>;
  // Which folder these came from: normally eventsPath, or the image's own
  // folder when the volume couldn't be prepared. The cockpit uses it to
  // decide whether edits can be saved.
  source: string;
}

// Reads the events folder and builds the registry. A function, so it
// can run again on reload. Throws only when there would be no page-view
// event (see the check at the end).
function buildRegistry(): BuiltRegistry {
  // The volume is the only source. The built-in events are copied into
  // it the first time it is empty (see seedEvents.ts for why only then).
  // So renaming or deleting a built-in is a normal file edit. When no
  // volume can be prepared (usually a git clone without /data), the
  // image's own folder is used, and seedEvents returns an error the
  // cockpit shows.
  const seeded = seedEvents(BUILT_IN_EVENTS_DIR, eventsPath);
  const loaded =
    seeded.source === BUILT_IN_EVENTS_DIR ? image : loadEvents(seeded.source);

  const registry: Record<string, EventDefinition> = { ...loaded.registry };
  const errors: SchemaFileError[] = [...seeded.errors, ...loaded.errors];

  // Fallback: a typo in the page-view file gets that file skipped, and
  // the registry can't work without a page-view event (see below), so one
  // bad character would stop the whole server.
  //
  // Registering the built-in copy instead keeps the server running and
  // page views recorded, and the broken file is reported like any other.
  // It only happens when no event has the tag, so a successful rename is
  // not affected.
  const imagePageView = resolveTaggedEvent(image.registry, "pageView");
  if (
    imagePageView !== undefined &&
    resolveTaggedEvent(registry, "pageView") === undefined &&
    !Object.hasOwn(registry, imagePageView)
  ) {
    registry[imagePageView] = image.registry[imagePageView];
    errors.push({
      file: seeded.source,
      messages: [
        `has no event tagged "${ROLE_TAG_KEYS.pageView}": true, which every ` +
          `page-scoped query resolves through, so the built-in ` +
          `"${imagePageView}" has been registered as a stand-in and page ` +
          `views are being recorded under that name. Fix or restore the ` +
          `file that should carry the tag — any other error listed here is ` +
          `probably it.`,
      ],
    });
  }

  // Exactly one event must have the tag: resolveTaggedEvent throws on
  // more than one, and this throws on none. Every page query depends on
  // it (top pages, referrers, entry/exit/bounce pages, the page views in
  // the traffic summary). Allowing none would mean every one of those
  // needs a "this deployment has no page views" case, kept apart from
  // "no data yet", for a kind of site that doesn't exist.
  //
  // A deployment that doesn't care about page views can register one and
  // never send it; zero then truly means zero page views.
  const taggedPageViewEvent = resolveTaggedEvent(registry, "pageView");
  if (taggedPageViewEvent === undefined) {
    throw new Error(
      `No registered event is tagged pageView: true, and exactly one must ` +
        `be — every page-scoped query and the client script resolve the ` +
        `page-view event through that tag rather than assuming a name. Add ` +
        `\`"_pageView": true\` to whichever event means "a page was viewed" ` +
        `in ${seeded.source}. Reaching this needs an event registered ` +
        `under the built-in page-view name but not carrying its tag, ` +
        `which is why the stand-in above could not be used. ` +
        `Registered events: ${Object.keys(registry).join(", ")}`,
    );
  }

  return {
    registry,
    errors,
    source: seeded.source,
    pageViewEventType: taggedPageViewEvent,
    // Which event each role the client sends is stored as, found through
    // the role tags. The client sends the role, never a name, so renaming
    // an event doesn't affect it (see AUTO_EVENT_ROLES in envelope.ts and
    // routes/events.ts).
    //
    // A role may have no event: a deployment that doesn't want outbound
    // click tracking registers no event with that tag. If the client still
    // sends it, the server rejects it as an unknown event type, saying
    // which tag is missing, in the same place as every other rejection.
    roleEventNames: {
      pageView: taggedPageViewEvent,
      outboundClick: resolveTaggedEvent(registry, "outboundClick"),
      fileDownload: resolveTaggedEvent(registry, "fileDownload"),
    },
  };
}

// Built once when this module loads, so a misconfigured registry fails
// at startup.
const built = buildRegistry();

// The exports below are `let`, not `const`, so reloadEvents can replace
// them. ES module imports are live bindings: every importer sees the new
// value, also through the re-export in index.ts. This only works because
// they are read inside request handlers. Copying one into a module-level
// constant would keep the old value forever (see docs/decisions.md).

// Event definitions by name. routes/events.ts looks up an incoming
// event's props schema here; list_event_types lists it.
export let eventRegistry: Record<string, EventDefinition> = built.registry;

// Files that were skipped, and why. The cockpit shows them; otherwise
// their events would pile up in rejected_events as unknown, with nothing
// saying why.
export let schemaErrors: readonly SchemaFileError[] = built.errors;

export let pageViewEventType: EventType = built.pageViewEventType;

// The folder the registry was read from, where edits must be written.
// It differs from eventsPath when no volume could be prepared: then the
// image's folder is used, and the cockpit says editing isn't possible
// instead of writing somewhere the next deploy throws away.
export let eventsSource: string = built.source;

export let roleEventNames: Readonly<Partial<Record<EventRoleTag, string>>> =
  built.roleEventNames;

export type ReloadResult =
  | { ok: true; eventCount: number; errors: readonly SchemaFileError[] }
  | { ok: false; error: string };

// Reads the event files again and replaces the registry, so a change
// takes effect without a restart (for example after an edit in the
// cockpit).
//
// Never throws and never replaces only part of the registry: if building
// fails, the old registry keeps running and the reason is returned. This
// runs from an HTTP request on a live server, where one bad file must not
// stop the process.
//
// Changes to EVENTS_PATH or other environment variables still need a
// restart.
export function reloadEvents(): ReloadResult {
  let next: BuiltRegistry;
  try {
    next = buildRegistry();
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  eventRegistry = next.registry;
  schemaErrors = next.errors;
  pageViewEventType = next.pageViewEventType;
  roleEventNames = next.roleEventNames;
  eventsSource = next.source;

  return {
    ok: true,
    eventCount: Object.keys(next.registry).length,
    errors: next.errors,
  };
}

export type ResetEventsResult =
  | { ok: true; removed: string[]; restored: string[] }
  | { ok: false; error: string };

const isEventFile = (name: string): boolean => name.endsWith(".json");

// Resets the events folder to the built-in events: every file on the
// volume is deleted, then the built-ins are copied again.
//
// Always the whole folder, not "everything except the built-ins". A
// built-in is renamed by renaming its file (see seedEvents), so after
// `page_view.json` becomes `seitenaufruf.json` there is no way to tell it
// from an event someone wrote. Deleting everything is the only reset that
// always does the same thing, and edits to built-ins are undone too.
//
// The caller reloads afterwards. This only changes files, so if it fails
// the server keeps running with the registry it had.
export function resetEvents(): ResetEventsResult {
  return resetEventFiles(BUILT_IN_EVENTS_DIR, eventsPath);
}

// resetEvents with both folders as parameters, so tests can use
// temporary folders instead of deleting the repository's own event
// files.
export function resetEventFiles(
  imageDir: string,
  volumeDir: string,
): ResetEventsResult {
  // EVENTS_PATH may point at the image's own folder. Then source and
  // target are the same files: deleting would remove the built-ins, and
  // copying would then copy nothing. Every file would be gone, and this
  // would report success.
  if (resolve(imageDir) === resolve(volumeDir)) {
    return {
      ok: false,
      error:
        `EVENTS_PATH points at the image's own event directory ` +
        `(${imageDir}), which is what a reset restores from — resetting ` +
        `would delete it. Nothing was changed.`,
    };
  }

  // Read the built-in files before deleting anything. They were checked
  // at startup, so this shouldn't fail, but if it did after deleting,
  // the deployment would have no events left.
  let builtIns: string[];
  try {
    builtIns = readdirSync(imageDir).filter(isEventFile);
  } catch (cause) {
    return {
      ok: false,
      error:
        `Could not read the built-in events at ${imageDir}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Nothing was changed.`,
    };
  }
  if (builtIns.length === 0) {
    return {
      ok: false,
      error:
        `No built-in event files were found at ${imageDir}, so ` +
        `there is nothing to reset to. Nothing was changed.`,
    };
  }

  let removed: string[];
  try {
    removed = readdirSync(volumeDir).filter(isEventFile);
    for (const file of removed) rmSync(join(volumeDir, file));
  } catch (cause) {
    return {
      ok: false,
      error:
        `Could not clear ${volumeDir}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}.`,
    };
  }

  // The folder is now empty, which is exactly when seedEvents copies the
  // built-ins, so the copying stays in one place.
  const seeded = seedEvents(imageDir, volumeDir);
  if (seeded.errors.length > 0) {
    return {
      ok: false,
      error:
        `The events directory was cleared but could not be re-seeded: ` +
        formatSchemaErrors(seeded.errors),
    };
  }

  return { ok: true, removed, restored: builtIns };
}

export interface RegistrySummary {
  [eventName: string]: {
    description: string;
    props: Record<string, PropMetadata>;
    // Unlike the role tags, which are left out on purpose (see "role
    // tags never reach the agent" in tools.test.ts), conversion is shown:
    // it marks a business goal, which matters to the agent and the
    // owner.
    conversion: boolean;
  };
}

// The registry without the Zod schemas: the descriptions and types that
// the MCP resource and the cockpit show. One function, so both always
// show the same.
//
// `registry` is a parameter so tests can pass their own. No built-in
// event sets _conversion, so with only the real registry a test couldn't
// check that `true` is passed through.
export function serializeRegistry(
  registry: Record<string, EventDefinition> = eventRegistry,
): RegistrySummary {
  const summary: RegistrySummary = {};
  for (const [name, definition] of Object.entries(registry)) {
    summary[name] = {
      description: definition.description,
      props: definition.props,
      conversion: definition.conversion,
    };
  }
  return summary;
}
