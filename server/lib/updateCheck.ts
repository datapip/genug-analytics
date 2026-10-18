// Checks whether a newer release exists, so the cockpit can show it next
// to the version. It reads the repo's git tags, because releases are only
// tags here (no GitHub Releases are created).
const REPO = "datapip/genug-analytics";
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags`;

// Replaced by startUpdateCheck once a day. Read it where you need it;
// a copy saved in a variable would keep the old value.
export let latestVersion: string | null = null;

// "v0.6.0" -> [0, 6, 0]. Anything else ("dev", an odd tag) returns null
// instead of throwing, so one odd tag doesn't break the whole check.
export function parseVersion(version: string): number[] | null {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewer(candidate: number[], current: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (candidate[i]! !== current[i]!) return candidate[i]! > current[i]!;
  }
  return false;
}

// Exported so it can be tested without a network call.
export function newestTag(
  tagNames: string[],
  current: number[],
): string | null {
  let best: { name: string; parsed: number[] } | null = null;
  for (const name of tagNames) {
    const parsed = parseVersion(name);
    if (!parsed) continue;
    if (!isNewer(parsed, best?.parsed ?? current)) continue;
    best = { name, parsed };
  }
  return best?.name ?? null;
}

// One request, and failure is fine. Without internet access, during a
// GitHub outage or when rate-limited, the server behaves as if it never
// asked: this is only a hint in the cockpit. A failure is not logged and
// leaves `latestVersion` unchanged.
export async function checkForUpdate(currentVersion: string): Promise<void> {
  const current = parseVersion(currentVersion);
  if (!current) return;

  try {
    const response = await fetch(TAGS_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const tags = (await response.json()) as { name: string }[];
    latestVersion = newestTag(
      tags.map((tag) => tag.name),
      current,
    );
  } catch {
    // Offline, blocked, rate-limited or a bad response: keep the last
    // known value, so one failed request doesn't hide the hint.
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Runs once at startup, then once a day: often enough that a new release
// shows up the same day, and far below GitHub's rate limit.
export function startUpdateCheck(currentVersion: string): void {
  void checkForUpdate(currentVersion);
  setInterval(
    () => void checkForUpdate(currentVersion),
    UPDATE_CHECK_INTERVAL_MS,
  );
}
