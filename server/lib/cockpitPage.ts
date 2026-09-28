import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every file the two pages load. Their addresses get `?v=<hash>` so a
// release is a new URL. A CDN in front may keep scripts for hours
// whatever the server says (Cloudflare's Browser Cache TTL raised
// `max-age=0` to four hours on the demo), while it leaves the page
// alone — and a new page running an old script breaks the moment the
// two disagree. A new URL is the one thing no cache can hold back.
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

// A hash of the contents, not the release number: a clone reports its
// version as "dev" forever, and file times are not reliable across
// Docker layers. One hash for all five: a wider invalidation costs
// nothing at a cockpit's traffic.
export function cockpitAssetVersion(dir: string): string {
  const hash = createHash("sha256");
  for (const name of COCKPIT_ASSETS) hash.update(readFileSync(join(dir, name)));
  return hash.digest("hex").slice(0, 10);
}

// Read on every call, so "edit the file, reload the page" still works
// with no restart and no build step. Only the fixed asset names above
// are rewritten; nothing from the request reaches the page.
export function renderCockpitPage(dir: string, page: CockpitPage): string {
  const version = cockpitAssetVersion(dir);
  return readFileSync(join(dir, page), "utf8").replace(
    ASSET_ATTRIBUTE,
    (_match, attribute: string, name: string) =>
      `${attribute}="${name}?v=${version}"`,
  );
}
