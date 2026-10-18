import { statfsSync } from "node:fs";
import { logError, logInfo } from "./logger.js";

// The floor under the volume /data lives on. /events is public, and the
// per-address rate limit bounds one client, not a crowd of them: enough
// addresses can fill any disk, and the daily backups multiply whatever
// got in. A full disk then fails everything at once — SQLite, the salt
// rotation, the history log — so collection stops a little short of it
// instead, while the rest of the server still works and can say why.
// Half a gigabyte leaves room for the WAL, a checkpoint and the logs.
export const MIN_FREE_BYTES = 512 * 1024 * 1024;

// statfs is one cheap system call, but /events can see thousands of
// requests a second; the answer is reused for this long.
const RECHECK_MS = 10 * 1000;

// Space an unprivileged process may use — bavail, not bfree, which
// counts the blocks reserved for root. Undefined when the filesystem
// cannot say: that must not stop collection on its own.
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
      // Logged on the change, not per request: once full, every event
      // would otherwise write a line onto the disk that has no room.
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
