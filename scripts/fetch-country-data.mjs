// Downloads the IP-to-country table that COUNTRY_LOOKUP=true uses
// (server/lib/country.ts) into server/country-data/. The Docker build
// runs it; run it by hand to try the lookup outside Docker.
//
//   node scripts/fetch-country-data.mjs
//
// The table is ip-location-db's "user-country", public domain (PDDL):
// https://github.com/sapics/ip-location-db
//
// Exits with an error on any failure, so no image is built without the
// table. Each file is written under a temporary name and then renamed,
// so a failed download never leaves half a table.
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";

const SOURCE =
  "https://github.com/sapics/ip-location-db/releases/download/latest/";
const FILES = ["user-country-ipv4-num.csv", "user-country-ipv6-num.csv"];

const dir = fileURLToPath(new URL("../server/country-data/", import.meta.url));
mkdirSync(dir, { recursive: true });

for (const file of FILES) {
  const response = await globalThis.fetch(SOURCE + file);
  if (!response.ok) {
    console.error(`${SOURCE + file}: HTTP ${response.status}`);
    process.exit(1);
  }
  const text = await response.text();
  const partial = join(dir, `${file}.partial`);
  writeFileSync(partial, text);
  renameSync(partial, join(dir, file));
  // The source file changes daily and no version is pinned, so log
  // which table this image contains.
  const sha256 = createHash("sha256").update(text).digest("hex");
  console.log(
    `${file}: ${text.split("\n").filter(Boolean).length} ranges, sha256 ${sha256}`,
  );
}
