import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const REQUIRED = {
  ALLOWED_ORIGIN: "https://site.example",
  TIMEZONE: "Europe/Berlin",
  MCP_API_KEY: "k".repeat(32),
  COCKPIT_PASSWORD: "a-cockpit-password",
};

// The second origin of a list is refused only inside the visitor's
// browser, with nothing in this server's log, so the split and trim are
// worth pinning on their own.
test("ALLOWED_ORIGIN is split on commas and trimmed", () => {
  const config = loadConfig({
    ...REQUIRED,
    ALLOWED_ORIGIN: "https://a.example, https://b.example",
  });
  assert.deepEqual(
    [...config.allowedOrigins],
    ["https://a.example", "https://b.example"],
  );
});

test("an ALLOWED_ORIGIN naming no origin is refused", () => {
  assert.throws(
    () => loadConfig({ ...REQUIRED, ALLOWED_ORIGIN: " , " }),
    /ALLOWED_ORIGIN must name at least one origin/,
  );
});

test("ALLOWED_ORIGIN's sites fold www into the apex", () => {
  const config = loadConfig({
    ...REQUIRED,
    ALLOWED_ORIGIN:
      "https://example.com, https://www.example.com, https://shop.example.com",
  });
  assert.deepEqual([...config.siteHosts], ["example.com", "shop.example.com"]);
});

test("an ALLOWED_ORIGIN entry that is no origin is refused by name", () => {
  assert.throws(
    () => loadConfig({ ...REQUIRED, ALLOWED_ORIGIN: "example.com" }),
    /"example\.com" is not an origin/,
  );
});

test("a missing required setting is refused by name", () => {
  for (const name of Object.keys(REQUIRED)) {
    const env: Record<string, string> = { ...REQUIRED };
    delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(name));
  }
});

// The startup warning hangs on whether RETENTION_DAYS was set at all,
// which the parsed number alone cannot tell.
test("an unset RETENTION_DAYS is the default, and -1 keeps everything", () => {
  const unset = loadConfig(REQUIRED);
  assert.equal(unset.retentionDaysIsDefault, true);
  assert.equal(typeof unset.retentionDays, "number");

  const forever = loadConfig({ ...REQUIRED, RETENTION_DAYS: "-1" });
  assert.equal(forever.retentionDaysIsDefault, false);
  assert.equal(forever.retentionDays, undefined);
});

// The daily salt, the cockpit's session salt and the backups are all
// put here, so they land on the database's volume.
test("the data directory is the database's own", () => {
  assert.equal(
    loadConfig({ ...REQUIRED, DB_PATH: "/x/y/genug.db" }).dataDir,
    "/x/y",
  );
  assert.equal(loadConfig(REQUIRED).dataDir, "/data");
});

// Turning it on changes what a deployment's privacy notice has to say,
// so an upgrade must never turn it on, and a typo must not either.
test("COUNTRY_LOOKUP is off unless set to true, and a typo is refused", () => {
  assert.equal(loadConfig(REQUIRED).countryLookup, false);
  assert.equal(
    loadConfig({ ...REQUIRED, COUNTRY_LOOKUP: "true" }).countryLookup,
    true,
  );
  assert.throws(
    () => loadConfig({ ...REQUIRED, COUNTRY_LOOKUP: "yes" }),
    /COUNTRY_LOOKUP must be "true" or "false"/,
  );
});
