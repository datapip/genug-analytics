import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SchemaFileError } from "./loadEvents.js";

// Copies the built-in events from the image onto the volume, so the
// volume can be the registry's only source.
//
// It has to be the only source so a deployment can rename a built-in
// (`page_view` to `seitenaufruf`, say). If the image's copy were still
// loaded, the renamed file would be a second event with "_pageView", and
// the image's files can't be changed from inside the container (`/app`
// belongs to root; the server runs as uid 1000).
//
// It copies only when EVENTS_PATH has no event files at all. Copying
// whatever is missing would break renaming: after renaming
// page_view.json to seitenaufruf.json, the next restart would copy
// page_view.json back, and two events would have the tag.
//
// The downside: an event added to your own image doesn't appear on a
// volume that already has files. Add it to the volume too.

export interface SeedResult {
  // The folder the registry should read: the volume, or the image's own
  // folder when the volume couldn't be prepared (usually a git clone
  // without /data).
  source: string;
  errors: SchemaFileError[];
}

const isEventFile = (name: string): boolean => name.endsWith(".json");

export function seedEvents(imageDir: string, eventsPath: string): SeedResult {
  if (hasEventFiles(eventsPath)) return { source: eventsPath, errors: [] };

  // Only copies into a folder whose parent exists. In a container /data
  // is the mounted volume and always exists; on a development machine it
  // usually doesn't, and creating it would leave stray /data/events
  // folders on laptops and in CI.
  const parent = dirname(eventsPath);
  if (!existsSync(parent)) {
    return {
      source: imageDir,
      errors: [
        {
          file: eventsPath,
          directory: true,
          messages: [
            `was not created because ${parent} does not exist, so events are ` +
              `being read from the image and nothing written here would ` +
              `persist. Expected when running from a clone; in a container ` +
              `it means EVENTS_PATH points somewhere the volume is not ` +
              `mounted.`,
          ],
        },
      ],
    };
  }

  try {
    mkdirSync(eventsPath, { recursive: true });
    for (const file of readdirSync(imageDir).filter(isEventFile)) {
      copyFileSync(join(imageDir, file), join(eventsPath, file));
    }
  } catch (cause) {
    return {
      source: imageDir,
      errors: [
        {
          file: eventsPath,
          directory: true,
          messages: [
            `could not be written: ` +
              `${cause instanceof Error ? cause.message : String(cause)}. ` +
              `Events are being read from the image instead, so the cockpit ` +
              `cannot change them and an edit made here would not survive a ` +
              `restart. A bind-mounted directory usually needs to belong to ` +
              `the user the server runs as: chown -R 1000:1000 on the host.`,
          ],
        },
      ],
    };
  }

  return { source: eventsPath, errors: [] };
}

// Missing is normal on the first start. An unreadable folder is treated
// the same way; the copy below then fails with its own, clearer error.
function hasEventFiles(directory: string): boolean {
  try {
    return readdirSync(directory).some(isEventFile);
  } catch {
    return false;
  }
}
