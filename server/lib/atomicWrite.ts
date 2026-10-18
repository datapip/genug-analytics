import { renameSync, rmSync, writeFileSync } from "node:fs";

// Replaces a file completely or not at all. A plain writeFileSync empties
// the file first and then writes, so a crash or a full disk in between
// leaves an empty or half-written file. For an event definition, that
// would mean the loader skips it and its events are rejected. So the data
// goes to a temporary file next to the target, which is then renamed over
// it. A rename within one directory is atomic: a reader sees either the
// old file or the new one. Code that reads only `.json` files ignores a
// leftover `.tmp` file.
//
// `mode` sets the file's permissions; the rename keeps them.
export function writeFileAtomic(
  path: string,
  data: string,
  mode?: number,
): void {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, data, { encoding: "utf8", mode });
    renameSync(temporary, path);
  } catch (error) {
    // Report the write's error. If the temporary file can't be removed
    // either, that is only clutter: the target file is unchanged.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // left behind
    }
    throw error;
  }
}
