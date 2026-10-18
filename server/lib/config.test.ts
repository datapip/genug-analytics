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
