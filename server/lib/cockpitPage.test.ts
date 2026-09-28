import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COCKPIT_ASSETS,
  cockpitAssetVersion,
  renderCockpitPage,
  type CockpitPage,
} from "./cockpitPage.js";

const COCKPIT_DIR = fileURLToPath(
  new URL("../../../apps/cockpit", import.meta.url),
);
const PAGES: CockpitPage[] = ["index.html", "login.html"];

function localAddresses(html: string): string[] {
  return [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)]
    .map((match) => match[1]!)
    .filter((value) => !value.startsWith("#") && !/^[a-z]+:/i.test(value));
}

// The rewrite matches exact strings, so a new file, or one written as
// "./cockpit.js", would slip through unversioned and silently bring the
// stale-script problem back. This reads the real pages to catch that.
test("every file the real pages load gets a version", () => {
  for (const page of PAGES) {
    const addresses = localAddresses(renderCockpitPage(COCKPIT_DIR, page));
    assert.ok(addresses.length > 0, `${page} loads nothing?`);
    for (const address of addresses) {
      assert.match(address, /\?v=[0-9a-f]{10}$/, `${page}: ${address}`);
    }
  }
});

test("nothing but the version suffix changes", () => {
  for (const page of PAGES) {
    const rendered = renderCockpitPage(COCKPIT_DIR, page);
    const onDisk = readFileSync(join(COCKPIT_DIR, page), "utf8");
    assert.equal(rendered.replace(/\?v=[0-9a-f]{10}"/g, '"'), onDisk);
  }
});

test("changing any asset changes the version", () => {
  const dir = mkdtempSync(join(tmpdir(), "genug-cockpit-page-"));
  try {
    cpSync(COCKPIT_DIR, dir, { recursive: true });
    // Compared with the step before, not the start: otherwise every
    // file after the first passes even if the hash ignores it.
    let before = cockpitAssetVersion(dir);
    for (const name of COCKPIT_ASSETS) {
      writeFileSync(join(dir, name), "changed " + name);
      const after = cockpitAssetVersion(dir);
      assert.notEqual(after, before, name);
      before = after;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing asset throws rather than rendering a page", () => {
  const dir = mkdtempSync(join(tmpdir(), "genug-cockpit-page-"));
  try {
    cpSync(COCKPIT_DIR, dir, { recursive: true });
    rmSync(join(dir, "theme.js"));
    assert.throws(() => renderCockpitPage(dir, "login.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
