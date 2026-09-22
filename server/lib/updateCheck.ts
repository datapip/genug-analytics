// Whether a newer release exists than the one running, so the cockpit
// can say so next to the version line. Nothing is created for this
// repo's own tags (docs/releasing.md's CI only builds and pushes an
// image on a tag push — see .github/workflows/ci.yml), so the GitHub
// Releases endpoint would just 404; the plain tags list is what
// actually has the data.
const REPO = "datapip/genug-analytics";
const TAGS_URL = `https://api.github.com/repos/${REPO}/tags`;

// A live binding, same reasoning as eventRegistry in
// @genug/schema-registry: startUpdateCheck below replaces it on its own
// schedule, and a consumer has to read this export directly rather than
// capture it in a local, or it would only ever see the value from the
// moment it was imported.
export let latestVersion: string | null = null;

// "v0.6.0" -> [0, 6, 0]. Anything that isn't exactly that shape (a
// clone's "dev", a malformed tag) returns null rather than throwing —
// this feature has nothing useful to say about a build with no
// comparable version, not a reason to fail the check for every tag
// around it.
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

// Exported for its own test rather than only through the network call,
// same split as checkForUpdate/parseVersion above.
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

// One request, best-effort. A deployment with no outbound access (or a
// GitHub outage, or a rate limit) should behave exactly like one that
// never asked — this is a convenience for the person reading the
// cockpit, not a thing the server depends on, so a failure here is
// never logged and never touches `latestVersion`.
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
    // Offline, blocked egress, rate-limited, malformed response — all
    // the same outcome: leave whatever was last known standing rather
    // than flicker the pill off on one bad request.
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Mirrors the retention/bot-activity jobs in index.ts: run once at
// startup, then once a day. A day is frequent enough that a fresh
// release shows up the same day for anyone who leaves the process
// running, and infrequent enough that even a very small deployment
// stays well inside GitHub's unauthenticated rate limit.
export function startUpdateCheck(currentVersion: string): void {
  void checkForUpdate(currentVersion);
  setInterval(
    () => void checkForUpdate(currentVersion),
    UPDATE_CHECK_INTERVAL_MS,
  );
}
