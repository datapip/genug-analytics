import { statfsSync } from "node:fs";
import { logError, logInfo } from "./logger.js";

// The minimum free space on the /data volume. /events is public, and the
// rate limit only limits each address, so many addresses together can
// still fill the disk (and the daily backups copy whatever got in). A full
// disk breaks everything at once: SQLite, the daily salt, the history log.
// So collection stops a little before that, while the rest of the server
// keeps working and can report why. Half a gigabyte leaves room for
// SQLite's write-ahead log, a checkpoint and the logs.
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

// statfs is cheap, but /events may get thousands of requests a second, so
// its answer is reused for this long.
const RECHECK_MS = 10 * 1000;

// Free space a normal (non-root) process may use: bavail, not bfree,
// which includes space reserved for root. Undefined when the filesystem
// can't tell; collection then carries on.
export function freeBytes(directory: string): number | undefined {
  try {
    const stats = statfsSync(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

export interface DiskGuard {
  hasRoom(now?: number): boolean;
}

export function createDiskGuard(
  directory: string,
  free: () => number | undefined = () => freeBytes(directory),
  minFreeBytes: number = MIN_FREE_BYTES,
): DiskGuard {
  let checkedAt = -Infinity;
  let room = true;

  return {
    hasRoom(now = Date.now()) {
      if (now - checkedAt < RECHECK_MS) return room;
      checkedAt = now;
      const bytes = free();
      const next = bytes === undefined || bytes >= minFreeBytes;
      // Log only when the state changes. Logging every refused event
      // would write to the disk that has no room left.
      if (next !== room) {
        if (next) {
          logInfo("disk space recovered, storing events again", {
            directory,
            freeBytes: bytes,
          });
        } else {
          logError(
            "disk space low, events are no longer stored",
            new Error(
              `${directory} has ${bytes} bytes free, under the ${minFreeBytes}-byte floor. Free space or lower RETENTION_DAYS; collection resumes by itself within seconds.`,
            ),
          );
        }
      }
      room = next;
      return room;
    },
  };
}
