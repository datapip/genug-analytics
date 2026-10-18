import { renameSync, rmSync, writeFileSync } from "node:fs";

// Replaces a file whole or not at all. writeFileSync truncates first and
// writes second, so a crash or a full disk between the two leaves an
// empty or half file — for an event definition, one the loader skips,
// and its events are rejected from then on. Written beside the target
// and renamed over it instead: a rename within one directory is atomic,
// so a reader sees the old file or the new one. The `.tmp` suffix keeps
// a leftover out of everything that reads only `.json` files.
//
// `mode` applies to the file as written; the rename keeps it.
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
    // The write's own error is the one worth reporting; a leftover that
    // cannot be removed either is only clutter beside an intact file.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // left behind
    }
    throw error;
  }
}
