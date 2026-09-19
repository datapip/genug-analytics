import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SchemaFileError } from "./loadEvents.js";

// Puts the events shipped in the image onto the volume, so that the
// volume can be the registry's only source.
//
// It has to be the only source, because a deployment must be able to
// rename a built-in — `page_view` to `seitenaufruf`, say. While the
// image's own copy is still loaded, the renamed file is a second event
// carrying "_pageView", and `/app` is root-owned while the server runs
// as uid 1000, so the image copy cannot be edited or deleted from
// inside the container. Copying it out once removes the problem instead
// of adding an exception to it.
//
// Seeding happens once: when EVENTS_PATH holds no event files at all.
// Copying whatever the volume happens to be *missing* sounds friendlier
// and breaks the very thing this exists for — renaming page_view.json
// to seitenaufruf.json leaves no page_view.json on the volume, so the
// next restart would copy it straight back and two events would carry
// the tag.
//
// The cost is the fork case: an event added to your own image does not
// appear on a volume that is already populated. Put it on the volume
// too, exactly as you would with a stock image.

export interface SeedResult {
  // The directory the registry should actually read. The volume, unless
  // it could not be prepared — running from a clone with no /data is
  // the ordinary reason, and then the image's own directory serves.
  source: string;
  errors: SchemaFileError[];
}

const isEventFile = (name: string): boolean => name.endsWith(".json");

export function seedEvents(imageDir: string, eventsPath: string): SeedResult {
  if (hasEventFiles(eventsPath)) return { source: eventsPath, errors: [] };

  // Only ever seeds into a directory whose parent is already there. In
  // a container /data is the mounted volume and always exists; on a
  // development machine it does not, and creating one would scatter a
  // stray /data/events across laptops and CI to hold a copy of files
  // the clone already has.
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

// Missing is the normal first-run case. Present but unreadable lands
// here too and is treated the same way: the copy below then fails on
// its own and says so, which is a better message than anything guessed
// from here.
function hasEventFiles(directory: string): boolean {
  try {
    return readdirSync(directory).some(isEventFile);
  } catch {
    return false;
  }
}
