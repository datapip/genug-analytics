import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every file the two cockpit pages load. Their URLs get `?v=<hash>`, so a
// new release means new URLs. A CDN in front of the server may cache
// scripts for hours whatever the server says (Cloudflare does), while it
// always fetches the page fresh. A new page with an old script breaks; a
// new URL can't be served from an old cache entry.
export const COCKPIT_ASSETS = [
  "cockpit.js",
  "cockpit.css",
  "theme.js",
  "login.js",
  "favicon.svg",
] as const;

export type CockpitPage = "index.html" | "login.html";

const ASSET_ATTRIBUTE = new RegExp(
  `\\b(src|href)="(${COCKPIT_ASSETS.map((name) => name.replace(/\./g, "\\.")).join("|")})"`,
  "g",
);

// A hash of the file contents, not the release number: a git clone always
// reports "dev", and file times change unpredictably in Docker images.
// One hash covers all five files; reloading all of them after any change
// costs nothing at the cockpit's traffic.
export function cockpitAssetVersion(dir: string): string {
  const hash = createHash("sha256");
  for (const name of COCKPIT_ASSETS) hash.update(readFileSync(join(dir, name)));
  return hash.digest("hex").slice(0, 10);
}

// Read from disk on every call, so an edited file shows up on reload
// without a restart. Only the fixed file names above are rewritten;
// nothing from the request is put into the page.
export function renderCockpitPage(dir: string, page: CockpitPage): string {
  const version = cockpitAssetVersion(dir);
  return readFileSync(join(dir, page), "utf8").replace(
    ASSET_ATTRIBUTE,
    (_match, attribute: string, name: string) =>
      `${attribute}="${name}?v=${version}"`,
  );
}
