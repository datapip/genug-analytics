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

// The events shipped inside the image: one JSON file each, in
// packages/schema-registry/events/. Resolved relative to this module
// rather than the working directory, because the server is started from
// wherever a deployment happens to put it.
const BUILT_IN_EVENTS_DIR = fileURLToPath(
  new URL("../events", import.meta.url),
);

const image = loadEvents(BUILT_IN_EVENTS_DIR);

// A file that arrived through a build is a developer error, so it stops
// the process rather than being skipped — the same fail-fast spirit as
// requireEnv. Nothing here reached a server without someone building
// it, so a broken one should never get as far as collecting data.
//
// Files on the volume are the opposite, and deliberately so: they were
// hand-edited on a live server, or written by the cockpit, where one
// typo must not take collection down for every other event.
if (image.errors.length > 0) {
  throw new Error(
    `Invalid event schema files in ${BUILT_IN_EVENTS_DIR}:
` + formatSchemaErrors(image.errors),
  );
}

// A deployment's own events, read from the persistent volume — the same
// `/data` the database lives on, so a stock image plus a volume is a
// complete customised setup with nothing to build. Overridable for
// local dev outside Docker, exactly like DB_PATH, and for the same
// reason: it is a filesystem path, not a secret.
//
// Reading an env var from inside this package is a small layering
// oddity. The alternative is turning the registry from a module-level
// constant into something the server constructs and threads through
// every consumer, which is a large change to buy nothing.
export const eventsPath: string = process.env.EVENTS_PATH ?? "/data/events";

// Was `keyof typeof eventRegistry`: a checked union of the four
// built-in names. Schemas are JSON read at startup now, so there is
// nothing left for the compiler to read — which event names exist is
// not knowable until the process runs, which is the entire point of the
// change (see docs/decisions.md).
//
// Nothing leaned on the union for safety. An event name arrives from
// the network as an arbitrary string and is checked against the
// registry at runtime either way. What is genuinely lost is a typo in
// server code that names an event being caught at save time.
export type EventType = string;

// The role tags an event may carry, written in the JSON files as
// `_pageView`, `_automaticOutboundClick` and `_automaticFileDownload`
// (checkEvent.ts maps the keys onto these names, and says why they
// differ). Each answers "which event means X in this
// deployment?", so nothing has to assume a fixed event name.
export type EventRoleTag = "pageView" | "outboundClick" | "fileDownload";

// Exported (and taking `registry` as a parameter, rather than reading
// eventRegistry directly) purely so tests can hand it a small synthetic
// registry to verify the "multiple tagged" error, without needing the
// real registry to be misconfigured.
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
  // Which directory these came from. Equal to eventsPath normally, and
  // to the image's own directory when the volume could not be prepared
  // — which is what tells the cockpit whether an edit can be saved.
  source: string;
}

// Everything that depends on reading a directory, in one function so it
// can run a second time. Throws on the one state nothing can serve —
// see the pageView check at the end.
function buildRegistry(): BuiltRegistry {
  // The volume is the only source, and gets the image's events copied
  // into it the first time it is empty (see seedEvents.ts for why that
  // has to happen exactly once). Nothing is layered over anything, so
  // renaming or deleting a built-in is an ordinary edit to an ordinary
  // file. Where a volume cannot be prepared at all — a clone with no
  // /data, most often — the image's own directory serves instead, and
  // seedEvents says so in an error the cockpit shows.
  const seeded = seedEvents(BUILT_IN_EVENTS_DIR, eventsPath);
  const loaded =
    seeded.source === BUILT_IN_EVENTS_DIR ? image : loadEvents(seeded.source);

  const registry: Record<string, EventDefinition> = { ...loaded.registry };
  const errors: SchemaFileError[] = [...seeded.errors, ...loaded.errors];

  // Last resort: a typo in the page-view file gets it skipped like any
  // other broken file, and the registry refuses to start without a
  // pageView event (see below) — so without this a single bad character
  // would take the whole deployment down, which is precisely the
  // failure loading volume files leniently exists to prevent.
  //
  // Re-registering the image's copy keeps the server up, keeps page
  // views being recorded under the name the client already sends, and
  // puts the real problem where every other rejected file appears. It
  // cannot quietly paper over an edit: it only runs when *nothing*
  // carries the tag, so a successful rename is untouched.
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

  // Exactly one event must carry the tag: resolveTaggedEvent throws on
  // more than one, and this throws on none. Required rather than
  // optional because every page-scoped query resolves through it
  // (get_top_pages, get_top_referrers, entry/exit/bounce pages, the
  // viewEvents half of every traffic summary), and because the
  // alternative was worse than it looked. Allowing zero meant every one
  // of those results carried an "or this deployment has no page-view
  // concept" case that had to be told apart from "no data yet", in the
  // types, in the cockpit, and in five tool descriptions the agent reads
  // on every call — to serve a browser-script analytics deployment that
  // does not track page views, which does not exist.
  //
  // A deployment that genuinely doesn't care registers one and never
  // fires it. An empty result then means zero page views, accurately,
  // which is the ambiguity the optional case existed to avoid.
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
    // Which event this deployment records each client-fired role as,
    // resolved through the role tags so a rename is invisible to the client
    // — it sends the role, never a name (see envelope.ts's AUTO_EVENT_ROLES
    // and routes/events.ts).
    //
    // A role may be absent: a deployment that does not want outbound-click
    // tracking simply registers no event carrying that tag. The client can
    // still be configured to fire it, and the server then rejects it as an
    // unknown event type with a detail saying which tag is missing — the
    // same one place every other mistracked event surfaces, rather than a
    // second diagnostic. This used to fall back to the built-in *name*,
    // which quietly produced the same rejection with a less useful reason
    // when that name was not registered either.
    roleEventNames: {
      pageView: taggedPageViewEvent,
      outboundClick: resolveTaggedEvent(registry, "outboundClick"),
      fileDownload: resolveTaggedEvent(registry, "fileDownload"),
    },
  };
}

// Built once at import, same fail-fast spirit as requireEnv — a
// misconfigured registry should break at startup, not silently pick one
// candidate later.
const built = buildRegistry();

// The four below are `let` rather than `const` so reloadEvents can
// replace them. ES module imports are live bindings, so every consumer
// sees the new value with no wiring of its own, including through this
// package's re-export in index.ts. That holds only because no consumer
// reads one of these at module scope — every use is inside a request
// handler, which was counted rather than assumed (see
// docs/decisions.md). Caching one in a module-level constant silently
// opts that consumer out of every reload.

// Lookup by event name — routes/events.ts uses this to find the props
// schema for an incoming event; mcp/tools.ts iterates it for
// list_event_types/get_schema.
export let eventRegistry: Record<string, EventDefinition> = built.registry;

// Files that were skipped, and why. Surfaced by the cockpit: a rejected
// file nobody can see is worse than useless, because the events it
// should have registered are instead piling up in rejected_events as an
// unknown type, with nothing saying why.
export let schemaErrors: readonly SchemaFileError[] = built.errors;

export let pageViewEventType: EventType = built.pageViewEventType;

// The directory the registry was actually read from, and the one an
// edit has to be written to. Not the same as eventsPath when seeding
// could not prepare a volume: the image's directory is then serving,
// and the cockpit must say editing is unavailable rather than write
// somewhere that is thrown away on the next deploy.
export let eventsSource: string = built.source;

export let roleEventNames: Readonly<Partial<Record<EventRoleTag, string>>> =
  built.roleEventNames;

export type ReloadResult =
  | { ok: true; eventCount: number; errors: readonly SchemaFileError[] }
  | { ok: false; error: string };

// Re-reads the event files and swaps the registry in place, so a schema
// change applies without a restart — which is what makes editing an
// event from the cockpit a whole action rather than half of one.
//
// Never throws, and never leaves the registry half-replaced: a build
// that fails is discarded entire and the running one keeps serving,
// with the reason handed back for the caller to show. That matters more
// here than at startup — this runs from an HTTP handler on a live
// server, where taking the process down over one bad file is the
// failure that loading volume files leniently exists to prevent.
//
// It cannot pick up EVENTS_PATH or any other env var. Those still need
// a real restart, and that is fine — it is not what this is for.
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

// Puts the events directory back to what the image ships: every file on
// the volume is removed, then the built-ins are copied out again.
//
// Deliberately the whole directory and not "the files that aren't
// built-ins". A deployment renames a built-in by renaming its file (see
// seedEvents), so after `page_view.json` becomes `seitenaufruf.json`
// there is no way left to tell a renamed built-in from an event
// somebody wrote — the name is all there is, and it is the thing that
// changed. Removing everything and re-seeding is the only version of
// this that means one predictable thing, and it is what "reset" should
// do anyway: edits to built-ins go too.
//
// The caller reloads. This touches files; it does not swap the running
// registry, so a failure here leaves the process serving exactly what
// it was serving before.
export function resetEvents(): ResetEventsResult {
  return resetEventFiles(BUILT_IN_EVENTS_DIR, eventsPath);
}

// The body of resetEvents, with both directories passed in so it can be
// tested against temporary ones — resetEvents itself closes over module
// constants fixed at import, and a test that could reach them would be
// deleting the repository's own event files.
export function resetEventFiles(
  imageDir: string,
  volumeDir: string,
): ResetEventsResult {
  // EVENTS_PATH can be pointed at the image's own directory, and then
  // the source and the target are the same files: clearing the volume
  // would delete the built-ins, and re-seeding would copy an empty
  // directory over itself. Every file would be gone and this would
  // report success.
  if (resolve(imageDir) === resolve(volumeDir)) {
    return {
      ok: false,
      error:
        `EVENTS_PATH points at the image's own event directory ` +
        `(${imageDir}), which is what a reset restores from — resetting ` +
        `would delete it. Nothing was changed.`,
    };
  }

  // Read the image's files before deleting anything on the volume. They
  // were validated at import, so this should not fail — but if it ever
  // did, deleting first would leave a deployment with no events at all
  // and nothing to restore them from.
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

  // seedEvents copies when the directory holds no event files, which is
  // exactly the state just created — so the one piece of code that
  // knows how to put the image's events on a volume stays the only one.
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
    // Unlike the three role tags (pageView/outboundClick/fileDownload,
    // deliberately excluded here — see "role tags never reach the
    // agent" in tools.test.ts), conversion is meant to reach both
    // readers of this summary: it marks a business goal, not client or
    // server wiring.
    conversion: boolean;
  };
}

// The registry, minus the Zod schemas — just the JSON-safe metadata
// consumers show to a human or an AI agent (the MCP resource, the
// cockpit). One function so both stay in sync automatically.
//
// Takes `registry` as a parameter, defaulting to the live one, for the
// same reason resolveTaggedEvent above does: none of the shipped
// built-in events set _conversion, so a test comparing this function's
// output against the real eventRegistry can only ever compare false to
// false — it would pass just as well if this function hardcoded
// `conversion: false`. Handing it a synthetic registry is what lets a
// test prove a `true` value actually survives the mapping.
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
