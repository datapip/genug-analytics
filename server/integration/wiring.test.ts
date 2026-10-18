import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations.js";
import { insertEvent } from "../db/events.js";
import { MAX_PROSE_FIELD_BYTES } from "../lib/context.js";

// These tests start the real compiled server (dist/index.js) as a
// separate process, to check what index.ts does around createApp:
// reading settings, the startup log, scheduling jobs, listening on the
// port and handling the stop signal. They are slower than the other
// tests, and they only see startup and shutdown, not a daily job running
// again later.
const indexJsPath = fileURLToPath(new URL("../index.js", import.meta.url));

interface LogLine {
  level: string;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

function tryParseLogLine(line: string): LogLine | undefined {
  try {
    return JSON.parse(line) as LogLine;
  } catch {
    return undefined; // e.g. a raw stack trace line from an uncaught throw
  }
}

interface RunningServer {
  process: ChildProcess;
  rawLines: string[];
  waitForLog(
    matches: (line: LogLine) => boolean,
    timeoutMs?: number,
  ): Promise<LogLine>;
  stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnServer(env: Record<string, string>): RunningServer {
  const child = spawn("node", [indexJsPath], {
    env: { ...process.env, ...env },
  });

  const rawLines: string[] = [];
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const captureLines = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) rawLines.push(line);
    }
  };
  child.stdout?.on("data", captureLines);
  child.stderr?.on("data", captureLines);

  function waitForLog(
    matches: (line: LogLine) => boolean,
    timeoutMs = 5000,
  ): Promise<LogLine> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        for (const raw of rawLines) {
          const parsed = tryParseLogLine(raw);
          if (parsed && matches(parsed)) {
            resolve(parsed);
            return;
          }
        }
        if (exited) {
          reject(
            new Error(
              `Process exited (code=${exited.code}, signal=${exited.signal}) before the expected log line appeared. Captured output:\n${rawLines.join("\n")}`,
            ),
          );
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(
            new Error(
              `Timed out waiting for a matching log line. Captured output:\n${rawLines.join("\n")}`,
            ),
          );
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function stop(): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }> {
    return new Promise((resolve) => {
      if (exited) {
        resolve(exited);
        return;
      }
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.kill("SIGTERM");
    });
  }

  return { process: child, rawLines, waitForLog, stop };
}

// Stops the server, then removes its data folder, in that order, in one
// hook. The server keeps the SQLite file open, and Windows can't remove a
// folder with open files. With two separate hooks, a failed removal
// would skip the stop, and the test run would hang on the still-running
// server.
function stopAndCleanUp(t: TestContext, dir: string, server: RunningServer) {
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
}

// Signs in to the cockpit, as the page does, and returns the session
// cookie in the form a browser sends it.
async function signInToCockpit(port: number): Promise<string> {
  const response = await fetch(`http://localhost:${port}/cockpit/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-genug-cockpit": "1" },
    body: JSON.stringify({ password: "test-cockpit-password" }),
  });
  const header = response.headers.get("set-cookie");
  assert.ok(header, `sign-in failed with ${response.status}`);
  return header.split(";")[0]!;
}

function baseEnv(dbPath: string, port: number): Record<string, string> {
  return {
    PORT: String(port),
    DB_PATH: dbPath,
    MCP_API_KEY: "test-key-0123456789abcdef0123456789",
    COCKPIT_PASSWORD: "test-cockpit-password",
    // example.com, because the test events are on it and /events only
    // stores urls on listed sites.
    ALLOWED_ORIGIN: `http://localhost:${port},https://example.com`,
    TIMEZONE: "UTC",
    LOCAL_BACKUPS: "false",
    // Next to DB_PATH. Without it, the server would create files in the
    // real /data/context of the machine running the tests.
    CONTEXT_PATH: join(dirname(dbPath), "context"),
  };
}

test("fails fast on an invalid PORT and never starts listening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), 4200),
    PORT: "not-a-number",
  });
  stopAndCleanUp(t, dir, server);

  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    server.process.once("exit", (code) => resolve({ code }));
  });

  assert.notEqual(code, 0);
  assert.equal(
    server.rawLines.some((line) => line.includes("listening")),
    false,
  );
});

// Without COCKPIT_PASSWORD the server must refuse to start, so the
// cockpit can never be open by accident. Checked on the real server, not
// only in the unit tests.
test("fails fast when COCKPIT_PASSWORD is missing and never starts listening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const env = baseEnv(join(dir, "test.db"), 4207);
  delete env.COCKPIT_PASSWORD;
  const server = spawnServer(env);
  stopAndCleanUp(t, dir, server);

  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    server.process.once("exit", (code) => resolve({ code }));
  });

  assert.notEqual(code, 0);
  assert.equal(
    server.rawLines.some((line) => line.includes("listening")),
    false,
  );
  assert.equal(
    server.rawLines.some((line) => line.includes("COCKPIT_PASSWORD")),
    true,
    "the failure should name the variable that's missing",
  );
});

// TIMEZONE has no default: without it, days and hours would quietly be
// UTC's. A fixed offset is refused too, since it is wrong for half the
// year wherever clocks change. Both must stop the real server.
for (const [label, value, port] of [
  ["missing", undefined, 4232],
  ["a fixed offset", "+01:00", 4233],
] as const) {
  test(`fails fast when TIMEZONE is ${label} and never starts listening`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

    const env = baseEnv(join(dir, "test.db"), port);
    if (value === undefined) delete env.TIMEZONE;
    else env.TIMEZONE = value;
    const server = spawnServer(env);
    stopAndCleanUp(t, dir, server);

    const { code } = await new Promise<{ code: number | null }>((resolve) => {
      server.process.once("exit", (code) => resolve({ code }));
    });

    assert.notEqual(code, 0);
    assert.equal(
      server.rawLines.some((line) => line.includes("listening")),
      false,
    );
    assert.equal(
      server.rawLines.some((line) => line.includes("TIMEZONE")),
      true,
      "the failure should name the variable",
    );
  });
}

test("starts, logs a structured ready message, and responds to /healthz", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4201;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);

  const ready = await server.waitForLog(
    (line) => line.msg === "genug server listening",
  );
  assert.equal(ready.port, port);

  const res = await fetch(`http://localhost:${port}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get("strict-transport-security"),
    "max-age=31536000",
  );
});

// The unit tests check the sign-in and API key checks on their own. This
// checks that app.ts really puts them in front of the routes they
// protect: swapping two lines there would leave the unit tests passing
// while /cockpit/data and /mcp were open to anyone.
test("keeps the guarded routes behind their auth, not just beside it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4204;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;

  // The JSON route and the page are set up separately, so check both.
  assert.equal((await fetch(`${base}/cockpit/data`)).status, 401);
  assert.equal((await fetch(`${base}/cockpit/index.html`)).status, 401);
  // The page has its own handler, not express.static, so check both of
  // its addresses.
  assert.equal((await fetch(`${base}/cockpit/`)).status, 401);
  // A write: it changes which events the server accepts.
  assert.equal(
    (
      await fetch(`${base}/cockpit/reload`, {
        method: "POST",
        headers: { "X-Genug-Cockpit": "1" },
      })
    ).status,
    401,
  );

  // And a session does open both; a cockpit refusing everything would
  // also pass the checks above.
  const cookie = await signInToCockpit(port);
  assert.equal(
    (await fetch(`${base}/cockpit/data`, { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/cockpit/index.html`, { headers: { cookie } })).status,
    200,
  );

  // Versioned file URLs and cache headers, so a CDN can't combine a new
  // page with an old script or keep a copy of a protected response.
  const page = await fetch(`${base}/cockpit/`, { headers: { cookie } });
  assert.equal(page.headers.get("cache-control"), "private, no-cache");
  assert.match(await page.text(), /src="cockpit\.js\?v=[0-9a-f]{10}"/);
  const script = await fetch(`${base}/cockpit/cockpit.js?v=x`, {
    headers: { cookie },
  });
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("cache-control"), "private, no-cache");
  const data = await fetch(`${base}/cockpit/data`, { headers: { cookie } });
  assert.equal(data.headers.get("cache-control"), "private, no-store");
  // With several sites, the top pages card shows each row's site.
  assert.deepEqual(((await data.json()) as { siteHosts: string[] }).siteHosts, [
    "localhost",
    "example.com",
  ]);
  // The sign-in page and the versioned files it loads stay public: the
  // check compares the path without the query string.
  const login = await fetch(`${base}/cockpit/login.html`);
  assert.equal(login.status, 200);
  const loginFiles = [
    ...(await login.text()).matchAll(/(?:src|href)="([^"#]+\?v=[^"]+)"/g),
  ].map((match) => match[1]!);
  assert.equal(loginFiles.length, 4);
  for (const file of loginFiles) {
    assert.equal((await fetch(`${base}/cockpit/${file}`)).status, 200, file);
  }
  // Without the trailing slash it is redirected, so relative URLs work.
  const bare = await fetch(`${base}/cockpit`, {
    headers: { cookie },
    redirect: "manual",
  });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get("location"), "/cockpit/");

  const mcpBody = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  };
  assert.equal((await fetch(`${base}/mcp`, mcpBody)).status, 401);

  // And the key does open it; a route rejecting everything would also
  // pass the checks above.
  const authorized = await fetch(`${base}/mcp`, {
    ...mcpBody,
    headers: {
      ...mcpBody.headers,
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key-0123456789abcdef0123456789",
    },
  });
  assert.notEqual(authorized.status, 401);

  // The sites reach the agent through the real route. If the route
  // stopped passing them it would still compile, since the option is
  // optional.
  const initialized = await fetch(`${base}/mcp`, {
    ...mcpBody,
    headers: {
      ...mcpBody.headers,
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key-0123456789abcdef0123456789",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "wiring-test", version: "1" },
      },
    }),
  });
  const initLine = (await initialized.text())
    .split("\n")
    .find((line) => line.startsWith("data: "));
  assert.ok(initLine, "expected a data: line in the MCP response");
  const { result } = JSON.parse(initLine.slice("data: ".length)) as {
    result: { serverInfo: { name: string }; instructions: string };
  };
  assert.equal(result.serverInfo.name, "genug (localhost, example.com)");
  assert.match(
    result.instructions,
    /collects for localhost, example\.com\..*host segment/,
  );
});

test("prunes events older than RETENTION_DAYS once at startup, not just on the 24h interval", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const dbPath = join(dir, "test.db");
  const port = 4202;

  const seedDb = new Database(dbPath);
  migrate(seedDb);
  const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  insertEvent(seedDb, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: oldTs,
    url: "https://example.com/",
    props: { page_title: "Home", document_language: "en" },
  });
  seedDb.close();

  const server = spawnServer({
    ...baseEnv(dbPath, port),
    RETENTION_DAYS: "30",
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const checkDb = new Database(dbPath, { readonly: true });
  const row = checkDb.prepare("SELECT COUNT(*) AS count FROM events").get() as {
    count: number;
  };
  checkDb.close();
  assert.equal(row.count, 0);
});

// RETENTION_DAYS=-1 keeps events forever.
test("RETENTION_DAYS=-1 keeps events forever, explicitly, without the unset warning", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const dbPath = join(dir, "test.db");
  const port = 4224;

  const seedDb = new Database(dbPath);
  migrate(seedDb);
  const oldTs = new Date(Date.now() - 900 * 24 * 60 * 60 * 1000).toISOString();
  insertEvent(seedDb, {
    event: "page_view",
    visitorId: "v1",
    sessionId: "s1",
    ts: oldTs,
    url: "https://example.com/",
    props: { page_title: "Home", document_language: "en" },
  });
  seedDb.close();

  const server = spawnServer({
    ...baseEnv(dbPath, port),
    RETENTION_DAYS: "-1",
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  // Nothing was deleted, and the log doesn't say RETENTION_DAYS is
  // unset.
  const checkDb = new Database(dbPath, { readonly: true });
  const row = checkDb.prepare("SELECT COUNT(*) AS count FROM events").get() as {
    count: number;
  };
  checkDb.close();
  assert.equal(row.count, 1);
  assert.equal(
    server.rawLines.some((line) => line.includes("RETENTION_DAYS")),
    false,
  );
});

// Checks that an unset RETENTION_DAYS really deletes events older than
// 396 days, not only that the log says so. Getting this wrong deletes
// data, so it is checked on the real server.
test("a deployment that never set RETENTION_DAYS prunes at the 396-day default, for real", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const dbPath = join(dir, "test.db");
  const port = 4225;

  const seedDb = new Database(dbPath);
  migrate(seedDb);
  const keptTs = new Date(Date.now() - 380 * 24 * 60 * 60 * 1000).toISOString();
  const prunedTs = new Date(
    Date.now() - 410 * 24 * 60 * 60 * 1000,
  ).toISOString();
  insertEvent(seedDb, {
    event: "page_view",
    visitorId: "kept",
    sessionId: "s1",
    ts: keptTs,
    url: "https://example.com/",
    props: { page_title: "Home", document_language: "en" },
  });
  insertEvent(seedDb, {
    event: "page_view",
    visitorId: "pruned",
    sessionId: "s2",
    ts: prunedTs,
    url: "https://example.com/",
    props: { page_title: "Home", document_language: "en" },
  });
  seedDb.close();

  // baseEnv doesn't set RETENTION_DAYS, which is the point.
  const server = spawnServer(baseEnv(dbPath, port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const checkDb = new Database(dbPath, { readonly: true });
  const rows = checkDb
    .prepare("SELECT visitor_id AS visitorId FROM events")
    .all() as { visitorId: string }[];
  checkDb.close();
  assert.deepEqual(
    rows.map((r) => r.visitorId),
    ["kept"],
  );
});

test("shuts down gracefully on SIGTERM: logs before exiting with code 0", async (t) => {
  // Windows has no POSIX signals: child.kill("SIGTERM") ends the process
  // at once, so there is no graceful shutdown to check. Skipped there;
  // the server runs on Linux, where this is tested.
  if (process.platform === "win32") {
    t.skip("Windows: SIGTERM can't be delivered to a child process");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4203;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const { code, signal } = await server.stop();

  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.ok(
    server.rawLines.some((line) => {
      const parsed = tryParseLogLine(line);
      return parsed?.msg === "Shutting down" && parsed.signal === "SIGTERM";
    }),
  );
});

// Bot hits are counted in memory and saved once an hour, so they must
// also be saved on shutdown, or a redeploy loses up to an hour of them.
test("writes the bot count on SIGTERM rather than losing it", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows: SIGTERM can't be delivered to a child process");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const dbPath = join(dir, "test.db");
  const port = 4235;

  const server = spawnServer(baseEnv(dbPath, port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const res = await fetch(`http://localhost:${port}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });
  assert.equal(res.status, 204);
  assert.equal((await server.stop()).code, 0);

  const checkDb = new Database(dbPath, { readonly: true });
  const row = checkDb
    .prepare("SELECT COALESCE(SUM(count), 0) AS total FROM bot_activity")
    .get() as { total: number };
  checkDb.close();
  assert.equal(row.total, 1);
});

// An unset RETENTION_DAYS means the default, and the server says so at
// startup, since it decides how much data is deleted.
test("says so at startup when RETENTION_DAYS is unset", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer(baseEnv(join(dir, "test.db"), 4210));
  stopAndCleanUp(t, dir, server);

  const line = await server.waitForLog((l) => l.msg.includes("RETENTION_DAYS"));
  assert.match(line.msg, /defaulting to 396 days/);
  assert.match(line.msg, /RETENTION_DAYS=-1/);
});

// A deployment that has set RETENTION_DAYS doesn't get that message.
test("stays quiet about retention when RETENTION_DAYS is set", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), 4211),
    RETENTION_DAYS: "90",
  });
  stopAndCleanUp(t, dir, server);

  await server.waitForLog((l) => l.msg.includes("listening"));
  assert.equal(
    server.rawLines.some((l) => l.includes("RETENTION_DAYS")),
    false,
  );
});

// The daily salt is kept in a file next to the database. If it weren't
// read at startup, every deploy would count each visitor twice, and
// nothing else would fail.
test("a restart on the same day keeps each visitor's id", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const dbPath = join(dir, "test.db");
  const port = 4226;
  const env = baseEnv(dbPath, port);

  const sendPageView = () =>
    fetch(`http://localhost:${port}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({
        auto: "pageView",
        url: "https://example.com/",
        props: { page_title: "Home", document_language: "en" },
      }),
    });

  const first = spawnServer(env);
  await first.waitForLog((line) => line.msg === "genug server listening");
  assert.equal((await sendPageView()).status, 204);
  await first.stop();

  const second = spawnServer(env);
  stopAndCleanUp(t, dir, second);
  await second.waitForLog((line) => line.msg === "genug server listening");
  assert.equal((await sendPageView()).status, 204);

  const checkDb = new Database(dbPath, { readonly: true });
  const ids = checkDb
    .prepare("SELECT DISTINCT visitor_id FROM events")
    .all() as { visitor_id: string }[];
  checkDb.close();
  assert.equal(ids.length, 1);
  // The 0600 mode is tested in lib/dailySalt.test.ts; here only that the
  // file is next to the database, as the docs say.
  assert.ok(existsSync(join(dir, "daily-salt.json")));
});

// The session key comes from the password and a salt kept next to the
// database. A new salt on every start would pass the unit tests but sign
// the owner out on every deploy.
test("a cockpit sign-in survives a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4236;
  const env = baseEnv(join(dir, "test.db"), port);

  const first = spawnServer(env);
  await first.waitForLog((line) => line.msg === "genug server listening");
  const cookie = await signInToCockpit(port);
  await first.stop();

  const second = spawnServer(env);
  stopAndCleanUp(t, dir, second);
  await second.waitForLog((line) => line.msg === "genug server listening");
  const res = await fetch(`http://localhost:${port}/cockpit/data?range=24h`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  assert.ok(existsSync(join(dir, "cockpit-session-salt")));
});

// The container runs as a normal user, so the most common deployment
// error is a data folder it can't write to. better-sqlite3 alone only
// says "unable to open database file"; the server must explain more.
test("explains an unwritable data directory instead of just failing", async (t) => {
  // Skipped on Windows, where chmod does nothing, and for root, which
  // ignores the mode. CI runs as a normal user on Linux, so it runs
  // there.
  if (process.platform === "win32") {
    t.skip("Windows: directory permissions don't work this way");
    return;
  }
  if (process.getuid?.() === 0) {
    t.skip("running as root: directory permissions don't apply");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const readOnly = join(dir, "readonly");
  mkdirSync(readOnly);
  chmodSync(readOnly, 0o500);

  const server = spawnServer(baseEnv(join(readOnly, "test.db"), 4212));
  // Its own hook instead of stopAndCleanUp: the mode must be restored
  // before the folder can be removed.
  t.after(async () => {
    await server.stop();
    chmodSync(readOnly, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    server.process.once("exit", (code) => resolve({ code }));
  });

  assert.notEqual(code, 0);
  const output = server.rawLines.join("\n");
  assert.match(output, /Could not open the database/);
  assert.match(output, /writable by the user this process runs as/);
  assert.match(output, /chown/);
  assert.equal(
    server.rawLines.some((line) => line.includes("listening")),
    false,
  );
});

// Reload on the real server: an event file added after startup is
// accepted without a restart. Only the whole app can show that the
// reloaded registry really reaches the /events handler.
test("picks up a new event file on reload, with no restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const eventsDir = join(dir, "events");
  const port = 4206;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: eventsDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const sendNewsletterSignup = () =>
    fetch(`${base}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({
        event: "newsletter_signup",
        url: "https://example.com/blog",
        props: { list_name: "weekly" },
      }),
    });

  // The volume only has the built-in events, so this name is unknown.
  assert.equal((await sendNewsletterSignup()).status, 400);

  writeFileSync(
    join(eventsDir, "newsletter_signup.json"),
    JSON.stringify({
      _description: "Fired when a visitor subscribes to the newsletter",
      list_name: "string",
      list_name_description: "Which list they subscribed to",
      list_name_example: "weekly",
    }),
  );

  // Still unknown until the server is told to reload.
  assert.equal((await sendNewsletterSignup()).status, 400);

  const reloaded = await fetch(`${base}/cockpit/reload`, {
    method: "POST",
    headers: { cookie: auth, "X-Genug-Cockpit": "1" },
  });
  assert.equal(reloaded.status, 200);
  assert.deepEqual(await reloaded.json(), {
    ok: true,
    eventCount: 4,
    errorCount: 0,
  });

  assert.equal((await sendNewsletterSignup()).status, 204);
});

// Reload changes the server's state, so it requires the CSRF header,
// which tells the cockpit page apart from a form on another site. Only
// this test would notice if that line were removed.
test("refuses a reload that did not come from the cockpit page", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4207;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const response = await fetch(`http://localhost:${port}/cockpit/reload`, {
    method: "POST",
    headers: {
      cookie: await signInToCockpit(port),
      "content-type": "application/x-www-form-urlencoded",
    },
  });

  assert.equal(response.status, 400);
});

// Someone with a stolen session cookie must not be able to guess the
// password in a confirmation box. Five wrong confirmations in a row sign
// every session out. Each also counts toward the sign-in lockout for its
// address, so ten block signing in from that address.
test("wrong danger-zone passwords sign sessions out and lock sign-in", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4227;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const confirm = (cookie: string, path: string, password: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-genug-cockpit": "1",
        origin: base,
      },
      body: JSON.stringify({ password }),
    });
  const paths = ["/cockpit/reset", "/cockpit/events/reset"];

  // Two rounds of five; each ends with a sign-out.
  for (let round = 0; round < 2; round++) {
    const cookie = await signInToCockpit(port);
    for (let i = 0; i < 4; i++) {
      // 403, because a 401 would send the owner to the sign-in page.
      const res = await confirm(cookie, paths[i % 2]!, "wrong");
      assert.equal(res.status, 403);
    }
    const fifth = await confirm(cookie, "/cockpit/reset", "wrong");
    assert.equal(fifth.status, 401);
    const after = await fetch(`${base}/cockpit/data?period=7d`, {
      headers: { cookie },
    });
    assert.equal(after.status, 401, "the session should be signed out");
  }

  // After ten failures from this address, sign-in is blocked, even with
  // the right password.
  const signIn = await fetch(`${base}/cockpit/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-genug-cockpit": "1" },
    body: JSON.stringify({ password: "test-cockpit-password" }),
  });
  assert.equal(signIn.status, 429);
  assert.ok(signIn.headers.get("retry-after"));
});

// Like the reload test above, for creating an event: the new event is
// accepted right away. The create route must reload the registry itself;
// otherwise the next event with that name would still be rejected.
test("accepts an event created from the cockpit, with no reload call", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4208;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const sendSignup = () =>
    fetch(`${base}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({
        event: "newsletter_signup",
        url: "https://example.com/blog",
        props: { plan: "pro", seats: 3 },
      }),
    });

  assert.equal((await sendSignup()).status, 400);

  const created = await fetch(`${base}/cockpit/events`, {
    method: "POST",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    body: JSON.stringify({
      name: "newsletter_signup",
      description: "Fired when a visitor subscribes to the newsletter",
      props: [
        {
          name: "plan",
          type: "text",
          optional: false,
          list: false,
          description: "Which plan they were looking at",
          example: ["pro"],
        },
        {
          name: "seats",
          type: "number",
          optional: true,
          list: false,
          description: "How many seats the plan was priced for",
          example: ["3"],
        },
      ],
    }),
  });

  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), {
    ok: true,
    name: "newsletter_signup",
    adoptedRows: 0,
    eventCount: 4,
    errorCount: 0,
  });

  assert.equal((await sendSignup()).status, 204);
});

// Like reload: creating an event changes what is accepted, so it
// requires the CSRF header.
test("refuses a creation that did not come from the cockpit page", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4209;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const response = await fetch(`http://localhost:${port}/cockpit/events`, {
    method: "POST",
    headers: {
      cookie: await signInToCockpit(port),
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "x", description: "y", props: [] }),
  });

  assert.equal(response.status, 400);
  assert.equal(existsSync(join(dir, "events", "x.json")), false);
});

// When EVENTS_PATH couldn't be prepared, the image's events are used. A
// change there would be lost on the next deploy, so every event write
// answers 409.
test("refuses event writes while events are read from the image", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4228;

  // The parent folder doesn't exist and is never created, so this path
  // isn't used.
  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "missing", "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const page = (await (
    await fetch(`${base}/cockpit/data?range=7d`, { headers: { cookie: auth } })
  ).json()) as { readOnly: boolean; schemaEditable: boolean };
  assert.equal(page.readOnly, false);
  assert.equal(page.schemaEditable, false);

  const writes: [string, string, unknown][] = [
    [
      "POST",
      "/cockpit/events",
      { name: "x", description: "x".repeat(20), props: [] },
    ],
    [
      "PUT",
      "/cockpit/events/page_view",
      {
        name: "page_view",
        description: "x".repeat(20),
        props: {},
        renameStoredEvents: false,
      },
    ],
    [
      "POST",
      "/cockpit/events/page_view/props",
      {
        name: "section",
        type: "text",
        optional: true,
        list: false,
        description: "x".repeat(20),
        example: ["news"],
      },
    ],
    ["DELETE", "/cockpit/events/page_view", undefined],
    ["POST", "/cockpit/events/reset", { password: "test-cockpit-password" }],
  ];
  for (const [method, path, body] of writes) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie: auth,
        "content-type": "application/json",
        "x-genug-cockpit": "1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 409, `${method} ${path}`);
    const json = (await response.json()) as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /read from the image/);
  }
  assert.equal(existsSync(join(dir, "missing")), false);
});

// The built-in page-view stand-in: it keeps a broken page-view file from
// stopping the whole server.
test("registers a stand-in page-view event when nothing carries the tag", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const eventsDir = join(dir, "events");
  const port = 4210;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: eventsDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  // Renamed and without its tag, so the built-in name is free and the
  // stand-in can take it. (A rename that keeps the tag is the normal case,
  // tested below; this is the mistake.)
  const renamed = JSON.parse(
    readFileSync(join(eventsDir, "page_view.json"), "utf8"),
  ) as Record<string, unknown>;
  delete renamed._pageView;
  rmSync(join(eventsDir, "page_view.json"));
  writeFileSync(join(eventsDir, "seitenaufruf.json"), JSON.stringify(renamed));

  const reloaded = await fetch(`${base}/cockpit/reload`, {
    method: "POST",
    headers: { cookie: auth, "X-Genug-Cockpit": "1" },
  });
  assert.equal(reloaded.status, 200, "the server must stay up, not fall over");
  assert.deepEqual(await reloaded.json(), {
    ok: true,
    eventCount: 4,
    errorCount: 1,
  });

  // The client sends the role, not a name, so this is what a real page
  // view looks like.
  const collected = await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });
  assert.equal(collected.status, 204, "page views must keep being recorded");

  const data = (await (
    await fetch(`${base}/cockpit/data?period=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as { schemaErrors: { messages: string[] }[] };

  assert.match(
    data.schemaErrors.map((error) => error.messages.join(" ")).join(" "),
    /stand-in/,
    "the cockpit has to say why, or the name change looks like it worked",
  );
});

// A failed reload must leave the running registry in place, still
// collecting events (see routes/cockpit/events.ts).
test("keeps collecting when a reload fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const eventsDir = join(dir, "events");
  const port = 4211;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: eventsDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  // The tag removed but the name kept: no event has pageView, and the
  // stand-in can't take a name that is already used, so building the
  // registry throws.
  const untagged = JSON.parse(
    readFileSync(join(eventsDir, "page_view.json"), "utf8"),
  ) as Record<string, unknown>;
  delete untagged._pageView;
  writeFileSync(join(eventsDir, "page_view.json"), JSON.stringify(untagged));

  const reloaded = await fetch(`${base}/cockpit/reload`, {
    method: "POST",
    headers: { cookie: auth, "X-Genug-Cockpit": "1" },
  });
  assert.equal(reloaded.status, 500);
  assert.equal(((await reloaded.json()) as { ok: boolean }).ok, false);

  const collected = await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });
  assert.equal(
    collected.status,
    204,
    "a failed reload must not take collection down with it",
  );
});

// The client sends a role, not a name, for the events it sends by
// itself. If no event has that role, the request is rejected under the
// role's name, and the detail says which key to add to an event file.
test("an automatic click with no tagged event is rejected under its role, naming the tag", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const eventsDir = join(dir, "events");
  const dbFile = join(dir, "test.db");
  const port = 4237;

  const server = spawnServer({
    ...baseEnv(dbFile, port),
    EVENTS_PATH: eventsDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const untagged = JSON.parse(
    readFileSync(join(eventsDir, "outbound_link_click.json"), "utf8"),
  ) as Record<string, unknown>;
  delete untagged._automaticOutboundClick;
  writeFileSync(
    join(eventsDir, "outbound_link_click.json"),
    JSON.stringify(untagged),
  );
  const reloaded = await fetch(`${base}/cockpit/reload`, {
    method: "POST",
    headers: { cookie: auth, "X-Genug-Cockpit": "1" },
  });
  assert.equal(reloaded.status, 200);

  const res = await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      auto: "outboundClick",
      url: "https://example.com/",
      props: {
        target_url: "https://partner.example/",
        target_host: "partner.example",
        link_text: "Partner",
      },
    }),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "no event is registered for automatic outboundClick tracking",
  });

  const db = new Database(dbFile, { readonly: true });
  try {
    assert.deepEqual(
      db.prepare("SELECT reason, event, detail FROM rejected_events").all(),
      [
        {
          reason: "unknown_event_type",
          event: "outboundClick",
          detail: 'no registered event carries "_automaticOutboundClick": true',
        },
      ],
    );
  } finally {
    db.close();
  }
});

// Renaming with "move stored rows". The risk: the rename reports moved
// rows, but the server still maps the role to the old name, so every
// later page view is rejected.
test("renames an event from the cockpit and keeps collecting under the new name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4212;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);
  const sendPageView = () =>
    fetch(`${base}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({
        auto: "pageView",
        url: "https://example.com/",
        props: { page_title: "Home", document_language: "en" },
      }),
    });

  assert.equal((await sendPageView()).status, 204);

  const renamed = await fetch(`${base}/cockpit/events/page_view`, {
    method: "PUT",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    body: JSON.stringify({
      name: "seitenaufruf",
      description: "Wird ausgelöst, wenn eine Seite aufgerufen wird",
      props: {},
      renameStoredEvents: true,
      reason: "The site is German now",
    }),
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), {
    ok: true,
    name: "seitenaufruf",
    movedRows: 1,
    eventCount: 3,
    errorCount: 0,
  });

  // The tag moved with the file, so the role now maps to the new name.
  // This is the main check of the test.
  assert.equal((await sendPageView()).status, 204);

  const data = (await (
    await fetch(`${base}/cockpit/data?period=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as {
    orphanedEvents: unknown[];
    storedEventCounts: Record<string, number>;
  };

  assert.deepEqual(
    data.orphanedEvents,
    [],
    "rows that moved with the rename are not stranded",
  );
  assert.equal(data.storedEventCounts.seitenaufruf, 2);
  assert.equal(data.storedEventCounts.page_view, undefined);

  // The rename is also added to the history log. Checked here, not only
  // in lib/autoHistory.test.ts, because the route uses the CONTEXT_PATH
  // setting, which only a real server process shows is used.
  const history = JSON.parse(
    readFileSync(join(dir, "context", "history.json"), "utf8"),
  ) as { from: string; note: string }[];
  assert.equal(history.length, 1);
  assert.equal(history[0]!.from, new Date().toISOString().slice(0, 10));
  assert.match(
    history[0]!.note,
    /^Recorded automatically: the event "page_view" was renamed to "seitenaufruf"\. 1 stored event moved to the new name\. Reason given: The site is German now$/,
  );

  // And it reaches the agent in the deployment-context document.
  const resource = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key-0123456789abcdef0123456789",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "genug://deployment-context" },
    }),
  });
  const line = (await resource.text())
    .split("\n")
    .find((each) => each.startsWith("data: "));
  assert.ok(line, "expected a data: line in the MCP response");
  const document = (
    JSON.parse(line.slice("data: ".length)) as {
      result: { contents: { text: string }[] };
    }
  ).result.contents[0]!.text;
  assert.match(document, /Recorded automatically: the event "page_view"/);

  // The numbers the agent reads. Page-view queries look up the tagged
  // event when they run; one using "page_view" would count no views here
  // and report a quiet day.
  const today = new Date().toISOString().slice(0, 10);
  const callTool = async (name: string) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-key-0123456789abcdef0123456789",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { from: today, to: today } },
      }),
    });
    const data = (await response.text())
      .split("\n")
      .find((each) => each.startsWith("data: "));
    assert.ok(data, `expected a data: line from ${name}`);
    const { result } = JSON.parse(data.slice("data: ".length)) as {
      result: { content: { text: string }[]; isError?: boolean };
    };
    assert.notEqual(result.isError, true, name);
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  };

  const summary = await callTool("get_traffic_summary");
  assert.equal(summary.viewEvents, 2);
  const pages = await callTool("get_top_pages");
  assert.deepEqual(pages.items, [{ host: "example.com", path: "/", views: 2 }]);
});

// Deleting the page-view event works when the built-in's name is free:
// 200, and page views are still recorded (by the built-in stand-in).
test("deletes the page-view event from the cockpit and falls back to the stand-in", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4205;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const sendPageView = () =>
    fetch(`${base}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://localhost:${port}`,
      },
      body: JSON.stringify({
        auto: "pageView",
        url: "https://example.com/",
        props: { page_title: "Home", document_language: "en" },
      }),
    });

  // One stored row before the delete, which the history entry must not
  // call orphaned.
  assert.equal((await sendPageView()).status, 204);

  const deleted = await fetch(`${base}/cockpit/events/page_view`, {
    method: "DELETE",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    // A DELETE with a body, which only ever holds the reason.
    body: JSON.stringify({ reason: "Back to the built-in shape" }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), {
    ok: true,
    name: "page_view",
    storedCount: 1,
    eventCount: 3,
    errorCount: 1,
  });

  // The stand-in took the name back, so the rows still match an event
  // and none are orphaned. Saying otherwise would give the agent a cause
  // for a drop that never happened.
  const afterDelete = JSON.parse(
    readFileSync(join(dir, "context", "history.json"), "utf8"),
  ) as { note: string }[];
  assert.equal(afterDelete.length, 1);
  assert.match(afterDelete[0]!.note, /"page_view" was deleted/);
  assert.match(afterDelete[0]!.note, /1 stored event still matches/);
  assert.match(
    afterDelete[0]!.note,
    /Reason given: Back to the built-in shape$/,
  );
  assert.doesNotMatch(afterDelete[0]!.note, /no longer match/);

  assert.equal(
    (await sendPageView()).status,
    204,
    "page views must keep being recorded",
  );
});

// The tests above are the stand-in case, where no rows are orphaned.
// This is the normal case: a deployment's own event is renamed without
// moving its rows (renameStoredEvents: false), so they are orphaned.
test("a rename that leaves rows behind reports them as stranded, not moved", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const eventsPath = join(dir, "events");
  const port = 4223;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: eventsPath,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  writeFileSync(
    join(eventsPath, "order_completed.json"),
    JSON.stringify({
      _description: "Fired when a visitor completes a checkout",
      order_id: "string",
      order_id_description: "The shop's own identifier for this order",
      order_id_example: "A-10432",
    }),
  );
  assert.equal(
    (
      await fetch(`${base}/cockpit/reload`, {
        method: "POST",
        headers: { cookie: auth, "x-genug-cockpit": "1" },
      })
    ).status,
    200,
  );

  await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      event: "order_completed",
      url: "https://example.com/thanks",
      props: { order_id: "A-1" },
    }),
  });

  const renamed = await fetch(`${base}/cockpit/events/order_completed`, {
    method: "PUT",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    body: JSON.stringify({
      name: "purchase_completed",
      description: "Fired when a visitor completes a checkout",
      props: {},
      renameStoredEvents: false,
    }),
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), {
    ok: true,
    name: "purchase_completed",
    movedRows: 0,
    // The 3 built-ins plus the deployment's own event: renaming
    // replaces the file rather than removing one.
    eventCount: 4,
    errorCount: 0,
  });

  const data = (await (
    await fetch(`${base}/cockpit/data?period=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as {
    orphanedEvents: { event: string; events: number; lastSeen: string }[];
    storedEventCounts: Record<string, number>;
  };

  // No event has the old name any more, so its row is reported as
  // orphaned instead of silently missing from the numbers.
  assert.equal(data.orphanedEvents.length, 1);
  assert.equal(data.orphanedEvents[0]!.event, "order_completed");
  assert.equal(data.orphanedEvents[0]!.events, 1);
  // storedEventCounts counts every stored row by name, registered or
  // not. The row is still under the old name; nothing is stored under the
  // new one.
  assert.equal(data.storedEventCounts.order_completed, 1);
  assert.equal(data.storedEventCounts.purchase_completed, undefined);

  const history = JSON.parse(
    readFileSync(join(dir, "context", "history.json"), "utf8"),
  ) as { note: string }[];
  assert.equal(history.length, 1);
  assert.match(
    history[0]!.note,
    /^Recorded automatically: the event "order_completed" was renamed to "purchase_completed"\. 1 stored event stayed under the old name and no longer matches a question asked by name\.$/,
  );
});

// Deleting an event must not break the registry. This sets up the one
// case where the registry can't be built without the file (the built-in
// name is taken by an untagged file, as in "keeps collecting when a
// reload fails" above) and deletes the event that has the tag. The file
// must be restored.
test("refuses to delete a page-view event that would leave the registry unable to load, and restores it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const eventsDir = join(dir, "events");
  const port = 4218;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: eventsDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  // Renamed with the tag kept, and an untagged file with the built-in's
  // name added. Deleting "seitenaufruf" would leave no page-view event,
  // and the stand-in can't take the name.
  const tagged = JSON.parse(
    readFileSync(join(eventsDir, "page_view.json"), "utf8"),
  ) as Record<string, unknown>;
  writeFileSync(join(eventsDir, "seitenaufruf.json"), JSON.stringify(tagged));
  const untagged = { ...tagged };
  delete untagged._pageView;
  writeFileSync(join(eventsDir, "page_view.json"), JSON.stringify(untagged));

  const reloaded = await fetch(`${base}/cockpit/reload`, {
    method: "POST",
    headers: { cookie: auth, "X-Genug-Cockpit": "1" },
  });
  assert.equal(reloaded.status, 200);

  const before = readFileSync(join(eventsDir, "seitenaufruf.json"), "utf8");

  const deleted = await fetch(`${base}/cockpit/events/seitenaufruf`, {
    method: "DELETE",
    headers: { cookie: auth, "X-Genug-Cockpit": "1" },
  });
  assert.equal(deleted.status, 409);
  assert.match(
    ((await deleted.json()) as { error: string }).error,
    /unable to load/,
  );

  assert.equal(
    readFileSync(join(eventsDir, "seitenaufruf.json"), "utf8"),
    before,
    "the deleted file must be back, byte for byte",
  );

  // And the history log doesn't claim the delete happened. The route
  // writes the entry only after this case has returned; writing it right
  // after deleting would log a delete that was undone.
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, "context", "history.json"), "utf8")),
    [],
    "a delete that was undone must leave nothing claiming it happened",
  );

  const collected = await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });
  assert.equal(
    collected.status,
    204,
    "the server must still be serving the registry from before the failed delete",
  );
});

// /cockpit/data runs ~16 queries and more in one handler, and an error
// anywhere blanks the whole page. A new deployment starts with an empty
// database, so check that case.
test("answers /cockpit/data on a database with nothing in it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4213;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const auth = await signInToCockpit(port);
  const res = await fetch(`http://localhost:${port}/cockpit/data?period=7d`, {
    headers: { cookie: auth },
  });

  assert.equal(res.status, 200);
  const data = (await res.json()) as Record<string, unknown>;

  for (const key of [
    "period",
    "trafficSummary",
    "trafficByDay",
    "trafficByDayOfWeek",
    "trafficByHour",
    "consentBreakdown",
    "topPages",
    "topReferrers",
    "deviceBreakdown",
    "recentEvents",
    "schemaRegistry",
    "schemaErrors",
    "orphanedEvents",
    "storedEventCounts",
    "toolManifest",
    "rejectedEventCount",
    "botActivityCount",
    "schemaEditable",
    "groundRules",
    "businessContext",
    "proseFieldMaxBytes",
    "history",
    "lastEventAt",
  ]) {
    assert.ok(key in data, `/cockpit/data is missing ${key}`);
  }
  // null, not missing: the page reads a missing value as "no events
  // stored".
  assert.equal(data.lastEventAt, null);

  // A `days` parameter gets an error, not 7-day numbers. 400, not 401,
  // because cockpitFetch treats 401 as "session ran out".
  const old = await fetch(`http://localhost:${port}/cockpit/data?days=30`, {
    headers: { cookie: auth },
  });
  assert.equal(old.status, 400);
  assert.match(((await old.json()) as { error: string }).error, /range/);
});

// Saving the ground rules and business context writes to CONTEXT_PATH,
// and adding a history entry writes to history.json: the three files
// lib/context.ts combines into the agent's document.
test("saves ground rules, business context and adds a history note from the cockpit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const contextDir = join(dir, "context");
  const port = 4219;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
    CONTEXT_PATH: contextDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const savedRules = await fetch(`${base}/cockpit/context/ground-rules`, {
    method: "PUT",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "x-genug-cockpit": "1",
    },
    body: JSON.stringify({ text: "Only answer in German." }),
  });
  assert.equal(savedRules.status, 200);
  assert.equal(
    readFileSync(join(contextDir, "ground-rules.md"), "utf8"),
    "Only answer in German.",
  );

  const savedContext = await fetch(`${base}/cockpit/context/about`, {
    method: "PUT",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "x-genug-cockpit": "1",
    },
    body: JSON.stringify({ text: "We sell handmade pottery." }),
  });
  assert.equal(savedContext.status, 200);
  assert.equal(
    readFileSync(join(contextDir, "about.md"), "utf8"),
    "We sell handmade pottery.",
  );

  const addedNote = await fetch(`${base}/cockpit/context/history`, {
    method: "POST",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "x-genug-cockpit": "1",
    },
    body: JSON.stringify({ from: "2026-05-03", note: "A redesign shipped." }),
  });
  assert.equal(addedNote.status, 200);
  const history = JSON.parse(
    readFileSync(join(contextDir, "history.json"), "utf8"),
  ) as { from: string; note: string }[];
  assert.deepEqual(history, [
    { from: "2026-05-03", note: "A redesign shipped." },
  ]);

  // /cockpit/data shows both, read from disk, not from a cache.
  const page = (await (
    await fetch(`${base}/cockpit/data?range=7d`, { headers: { cookie: auth } })
  ).json()) as {
    groundRules: { text: string; usingDefault: boolean };
    businessContext: { text: string };
    history: { entries: { note: string }[] };
  };
  assert.equal(page.groundRules.text, "Only answer in German.");
  assert.equal(page.groundRules.usingDefault, false);
  assert.equal(page.businessContext.text, "We sell handmade pottery.");
  assert.deepEqual(
    page.history.entries.map((e) => e.note),
    ["A redesign shipped."],
  );
});

// A `"` takes 2 bytes in JSON (`\"`), so text at MAX_PROSE_FIELD_BYTES
// made only of quotes is twice as big in the request. The request size
// limit must leave room for that, so the save still works.
test("saves ground rules made entirely of characters that double in size once JSON-escaped", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const contextDir = join(dir, "context");
  const port = 4220;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
    CONTEXT_PATH: contextDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const text = '"'.repeat(MAX_PROSE_FIELD_BYTES);
  const saved = await fetch(`${base}/cockpit/context/ground-rules`, {
    method: "PUT",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "x-genug-cockpit": "1",
    },
    body: JSON.stringify({ text }),
  });

  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(contextDir, "ground-rules.md"), "utf8"), text);
});

// Reset database: an event is stored, then a reset with the wrong
// password and one with the right password. Only the second empties the
// database.
test("wipes stored events from the cockpit only when the password is confirmed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4214;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });

  const wrongPassword = await fetch(`${base}/cockpit/reset`, {
    method: "POST",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    body: JSON.stringify({ password: "not-the-password" }),
  });
  // 403, not 401: the session is fine, only the retyped password is
  // wrong. cockpit.js treats a 401 as "the session ran out" and would
  // show the sign-in page.
  assert.equal(wrongPassword.status, 403);

  const beforeReset = (await (
    await fetch(`${base}/cockpit/data?period=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as { storedEventCounts: Record<string, number> };
  assert.equal(beforeReset.storedEventCounts.page_view, 1);

  const reset = await fetch(`${base}/cockpit/reset`, {
    method: "POST",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    body: JSON.stringify({ password: "test-cockpit-password" }),
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), {
    ok: true,
    eventsDeleted: 1,
    rejectedEventsDeleted: 0,
    botActivityDeleted: 0,
  });

  const afterReset = (await (
    await fetch(`${base}/cockpit/data?period=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as { storedEventCounts: Record<string, number> };
  assert.deepEqual(afterReset.storedEventCounts, {});
});

// Like /cockpit/reload, the reset requires the CSRF header. SameSite=Lax
// already protects it; the header still protects it if the cookie
// settings ever change.
test("refuses a reset that did not come from the cockpit page", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4215;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const response = await fetch(`http://localhost:${port}/cockpit/reset`, {
    method: "POST",
    headers: {
      cookie: await signInToCockpit(port),
      "content-type": "application/json",
    },
    body: JSON.stringify({ password: "test-cockpit-password" }),
  });

  assert.equal(response.status, 400);
});

// Reset events: puts the built-in event files back, which can leave
// stored rows under a name no event has.
test("resets the events directory to the built-ins and reports what it stranded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4216;
  const eventsPath = join(dir, "events");

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: eventsPath,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie: auth,
        "content-type": "application/json",
        "X-Genug-Cockpit": "1",
      },
      body: JSON.stringify(body),
    });

  // A deployment's own event, with one stored row.
  writeFileSync(
    join(eventsPath, "order_completed.json"),
    JSON.stringify({
      _description: "Fired when a visitor completes a checkout",
      order_id: "string",
      order_id_description: "The shop's own identifier for this order",
      order_id_example: "A-10432",
    }),
  );
  const reloaded = await post("/cockpit/reload", {});
  assert.equal(reloaded.status, 200);

  await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      event: "order_completed",
      url: "https://example.com/thanks",
      props: { order_id: "A-1" },
    }),
  });

  const wrongPassword = await post("/cockpit/events/reset", {
    password: "not-the-password",
  });
  assert.equal(wrongPassword.status, 403);
  // A refused attempt changes nothing.
  assert.ok(readdirSync(eventsPath).includes("order_completed.json"));

  const reset = await post("/cockpit/events/reset", {
    password: "test-cockpit-password",
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), {
    ok: true,
    removed: 4,
    eventCount: 3,
    errorCount: 0,
    // The row of the removed event is still stored, and now matches no
    // event.
    stranded: [{ event: "order_completed", count: 1 }],
  });

  assert.ok(!readdirSync(eventsPath).includes("order_completed.json"));

  // Also added to the history log, with both numbers. They come from
  // different places (files replaced, rows orphaned), so check each one,
  // not only that an entry exists.
  const history = JSON.parse(
    readFileSync(join(dir, "context", "history.json"), "utf8"),
  ) as { note: string }[];
  assert.equal(history.length, 1);
  assert.match(history[0]!.note, /replacing 4 files/);
  assert.match(history[0]!.note, /order_completed \(1\)/);

  // The registry is reloaded without a restart, and the orphaned row is
  // reported to the cockpit.
  const data = (await (
    await fetch(`${base}/cockpit/data?range=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as {
    schemaRegistry: Record<string, unknown>;
    orphanedEvents: { event: string; count: number }[];
  };
  assert.deepEqual(Object.keys(data.schemaRegistry).sort(), [
    "file_download",
    "outbound_link_click",
    "page_view",
  ]);
  assert.deepEqual(
    data.orphanedEvents.map((row) => row.event),
    ["order_completed"],
  );
});

// Read-only mode, used by the public demo. It involves three files (the
// tool list in mcp/tools.ts, the cockpit's write refusal in
// routes/cockpit.ts and the startup log in index.ts), so it is checked
// on the running server.
test("READ_ONLY=true unregisters the delete tool and closes every cockpit write", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4217;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "events"),
    READ_ONLY: "true",
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg.startsWith("READ_ONLY is set"));
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  // The MCP transport answers as a server-sent event stream; the
  // response is in one `data:` line.
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key-0123456789abcdef0123456789",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const data = (await response.text())
    .split("\n")
    .find((line) => line.startsWith("data: "));
  assert.ok(data, "expected a data: line in the MCP response");
  const listed = JSON.parse(data.slice("data: ".length)) as {
    result: { tools: { name: string }[] };
  };
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes("get_traffic_summary"));
  assert.ok(!names.includes("delete_visitor_data"));
  // Writes nothing, but returns raw rows instead of totals.
  assert.ok(!names.includes("get_recent_events"));

  // Every write route, with the CSRF header and the password, so the
  // only reason to refuse is read-only mode.
  const writes: [string, string, unknown][] = [
    ["POST", "/cockpit/reload", undefined],
    [
      "PUT",
      "/cockpit/events/page_view",
      {
        name: "page_view",
        description: "x".repeat(20),
        props: {},
        renameStoredEvents: false,
      },
    ],
    [
      "POST",
      "/cockpit/events",
      { name: "x", description: "x".repeat(20), props: [] },
    ],
    [
      "POST",
      "/cockpit/events/page_view/props",
      {
        name: "section",
        type: "text",
        optional: true,
        list: false,
        description: "x".repeat(20),
        example: ["news"],
      },
    ],
    ["DELETE", "/cockpit/events/page_view", { reason: "Not needed." }],
    ["POST", "/cockpit/events/reset", { password: "test-cockpit-password" }],
    ["POST", "/cockpit/reset", { password: "test-cockpit-password" }],
    ["PUT", "/cockpit/context/ground-rules", { text: "New rules." }],
    ["PUT", "/cockpit/context/about", { text: "New context." }],
    [
      "POST",
      "/cockpit/context/history",
      { from: "2026-05-03", note: "A redesign shipped." },
    ],
  ];
  for (const [method, path, body] of writes) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie: auth,
        "content-type": "application/json",
        "x-genug-cockpit": "1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, 403, `${method} ${path}`);
    const json = (await response.json()) as { ok: boolean; error: string };
    assert.equal(json.ok, false);
    assert.match(json.error, /read-only/);
  }

  // Reading still works, and the page is told it is read-only.
  const page = (await (
    await fetch(`${base}/cockpit/data?range=7d`, {
      headers: { cookie: auth },
    })
  ).json()) as {
    readOnly: boolean;
    schemaEditable: boolean;
    toolManifest: { name: string }[];
  };
  assert.equal(page.readOnly, true);
  assert.equal(page.schemaEditable, false);
  assert.ok(
    !page.toolManifest.some((tool) => tool.name === "delete_visitor_data"),
  );

  // Events are still collected: the demo's own traffic is its data.
  const collected = await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });
  assert.equal(collected.status, 204);

  // The stored row is counted but not listed: the recent-events list is
  // the same raw data as get_recent_events, and anyone with the demo
  // link can see the page.
  const after = (await (
    await fetch(`${base}/cockpit/data?range=24h`, {
      headers: { cookie: auth },
    })
  ).json()) as {
    recentEvents: unknown[];
    trafficSummary: { visitors: number };
  };
  assert.equal(after.trafficSummary.visitors, 1);
  assert.deepEqual(after.recentEvents, []);

  // In this mode the data is cached briefly, so many viewers reloading
  // don't each run the queries. So a second event within that time
  // isn't counted yet.
  const second = await fetch(`${base}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `http://localhost:${port}`,
      "user-agent": "a-second-visitor",
    },
    body: JSON.stringify({
      auto: "pageView",
      url: "https://example.com/",
      props: { page_title: "Home", document_language: "en" },
    }),
  });
  assert.equal(second.status, 204);
  const cached = (await (
    await fetch(`${base}/cockpit/data?range=24h`, {
      headers: { cookie: auth },
    })
  ).json()) as { trafficSummary: { visitors: number } };
  assert.equal(cached.trafficSummary.visitors, 1);

  // And only because of the cache: the row was stored, and an uncached
  // read counts it.
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const summaryText = (
    await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-key-0123456789abcdef0123456789",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_traffic_summary",
            arguments: { from: day(-1), to: day(1) },
          },
        }),
      })
    ).text()
  )
    .split("\n")
    .find((line) => line.startsWith("data: "));
  assert.ok(summaryText, "expected a data: line in the MCP response");
  const summary = JSON.parse(
    (
      JSON.parse(summaryText.slice("data: ".length)) as {
        result: { content: { text: string }[] };
      }
    ).result.content[0]!.text,
  ) as { visitors: number };
  assert.equal(summary.visitors, 2);
});

test("refuses to start on a READ_ONLY value that is neither true nor false", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), 4218),
    READ_ONLY: "yes",
  });
  stopAndCleanUp(t, dir, server);

  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    server.process.once("exit", (code) => resolve({ code }));
  });
  assert.notEqual(code, 0);
  assert.ok(server.rawLines.some((line) => line.includes("READ_ONLY must be")));
  assert.ok(!server.rawLines.some((line) => line.includes("listening")));
});

// Two rate limits per address, one for requests with the right key and
// one for the rest, so a stranger sharing a hosted agent's address can't
// use up the owner's. The unit tests check the middleware; this checks
// that routes/mcp.ts uses it.
test("rate limits /mcp per address, with the key and without it apart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4219;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const request = (key = "test-key-0123456789abcdef0123456789") =>
    fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  // A stranger uses up the limit for requests without a key; the owner
  // isn't affected.
  for (let i = 0; i < 10; i++) {
    assert.equal((await request("wrong-key")).status, 401, `guess ${i + 1}`);
  }
  assert.equal((await request("wrong-key")).status, 429);
  assert.equal((await request()).status, 200);

  for (let i = 1; i < 60; i++) {
    assert.equal((await request()).status, 200, `request ${i + 1}`);
  }

  const refused = await request();
  assert.equal(refused.status, 429);
  // The agent must be told how long to wait, or it reports an outage.
  const retryAfter = Number(refused.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
  assert.deepEqual(await refused.json(), {
    error: "rate limit reached",
    retryAfterSeconds: retryAfter,
  });

  const line = await server.waitForLog(
    (l) => l.msg === "rate limit reached" && l.route === "/mcp",
  );
  assert.equal(line.limit, 60);
});

// A short key is allowed, but the server warns: /mcp has no lockout, so
// the key's length is what stops guessing.
test("warns about a short MCP_API_KEY but still starts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), 4234),
    MCP_API_KEY: "too-short",
  });
  stopAndCleanUp(t, dir, server);

  const warning = await server.waitForLog((line) =>
    String(line.msg).startsWith("MCP_API_KEY is 9 characters"),
  );
  assert.match(String(warning.msg), /openssl rand -hex 32/);
  await server.waitForLog((line) => line.msg === "genug server listening");
});

// One request may carry only one JSON-RPC message. The transport would
// accept an array, so without the check in routes/mcp.ts one request
// could carry hundreds of tool calls and get around the rate limit.
test("refuses a batched JSON-RPC body on /mcp", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4220;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key-0123456789abcdef0123456789",
    },
    body: JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
  });

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: { message: string } };
  assert.match(body.error.message, /Batched requests are not accepted/);
});

// The unit tests in lib/context.test.ts pass their own folder, so they
// can't tell "served the owner's file" from "served the built-in because
// the file wasn't found". Here the server creates the real folder, the
// files are changed while it runs, and the resource is read over HTTP.
//
// This also checks that the files are read on every request, not cached:
// the edit happens after startup, so a cached read would fail here.
test("the deployment-context resource serves the seeded file, and edits are live", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4221;
  const contextDir = join(dir, "context");

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    CONTEXT_PATH: contextDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog(
    (line) => line.msg === "Wrote the default context files",
  );
  await server.waitForLog((line) => line.msg === "genug server listening");

  const groundRules = join(contextDir, "ground-rules.md");
  assert.match(readFileSync(groundRules, "utf8"), /Ask rather than guess/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(contextDir, "history.json"), "utf8")),
    [],
  );

  // Both written after startup, so only reading on every request finds
  // them.
  writeFileSync(groundRules, "Answer only in Swiss German.");
  writeFileSync(
    join(contextDir, "history.json"),
    JSON.stringify([
      { from: "2026-06-15", note: "Relaunched the pricing page." },
    ]),
  );

  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key-0123456789abcdef0123456789",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "genug://deployment-context" },
    }),
  });
  const data = (await response.text())
    .split("\n")
    .find((line) => line.startsWith("data: "));
  assert.ok(data, "expected a data: line in the MCP response");
  const read = JSON.parse(data.slice("data: ".length)) as {
    result: { contents: { text: string }[] };
  };
  const document = read.result.contents[0]!.text;

  assert.match(document, /Answer only in Swiss German\./);
  assert.match(document, /\*\*2026-06-15\*\* — Relaunched the pricing page\./);
  // Check the content, not just the heading: the built-in text or the
  // "nothing found" text would have the same heading.
  assert.equal(document.includes("Ask rather than guess"), false);
  assert.equal(document.includes("There is no file at"), false);
  assert.equal(document.includes("No events have been recorded"), false);
});

// lib/history.test.ts passes its own path. The MCP tool uses the
// CONTEXT_PATH setting instead, which only a real server process can
// show. So: write a note over MCP, then read the document over MCP and
// find the note in it.
test("add_history_note writes into the same file the resource serves", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4222;
  const contextDir = join(dir, "context");

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    CONTEXT_PATH: contextDir,
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const call = async (method: string, params: unknown) => {
    const response = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-key-0123456789abcdef0123456789",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const data = (await response.text())
      .split("\n")
      .find((line) => line.startsWith("data: "));
    assert.ok(data, "expected a data: line in the MCP response");
    return JSON.parse(data.slice("data: ".length)) as {
      result: {
        content?: { text: string }[];
        contents?: { text: string }[];
        isError?: boolean;
      };
    };
  };

  const written = await call("tools/call", {
    name: "add_history_note",
    arguments: {
      date: "2026-06-15",
      end_date: "2026-06-20",
      note: "Ran a discount campaign on the pricing page.",
    },
  });
  assert.notEqual(written.result.isError, true);
  // The tool must return what it saved, not just "ok", so a wrong date
  // can be noticed.
  assert.match(
    written.result.content![0]!.text,
    /Ran a discount campaign on the pricing page\./,
  );

  // A second call checks two things. That the tool adds to the file
  // rather than overwriting it. And the common case of a single day
  // without end_date: the stored entry must not get `"to": null`, and the
  // document must show one date, not a range.
  const second = await call("tools/call", {
    name: "add_history_note",
    arguments: {
      date: "2026-07-01",
      note: "Moved the pricing page to /plans, with a redirect.",
    },
  });
  assert.notEqual(second.result.isError, true);
  assert.match(second.result.content![0]!.text, /2026-07-01 — Moved the/);

  const stored = () =>
    JSON.parse(
      readFileSync(join(contextDir, "history.json"), "utf8"),
    ) as Record<string, string>[];
  assert.deepEqual(stored(), [
    {
      from: "2026-06-15",
      to: "2026-06-20",
      note: "Ran a discount campaign on the pricing page.",
    },
    {
      from: "2026-07-01",
      note: "Moved the pricing page to /plans, with a redirect.",
    },
  ]);

  // A refused note must be reported as an error, not as saved. The date
  // is one Date.parse would accept although it doesn't exist.
  const before = readFileSync(join(contextDir, "history.json"), "utf8");
  const refused = await call("tools/call", {
    name: "add_history_note",
    arguments: { date: "2026-02-31", note: "A day that does not exist." },
  });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content![0]!.text, /Nothing was recorded/);
  assert.equal(readFileSync(join(contextDir, "history.json"), "utf8"), before);

  const read = await call("resources/read", {
    uri: "genug://deployment-context",
  });
  assert.match(
    read.result.contents![0]!.text,
    /\*\*2026-06-15 to 2026-06-20\*\* — Ran a discount campaign/,
  );
  assert.match(
    read.result.contents![0]!.text,
    /\*\*2026-07-01\*\* — Moved the/,
  );
});

// The kept URL parts are read when lib/url.ts loads; checked on the real
// server, like TRUST_PROXY and READ_ONLY above.
test("fails fast on an invalid KEPT_QUERY_PARAMS and never starts listening", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), 4229),
    KEPT_QUERY_PARAMS: "utm_*",
  });
  stopAndCleanUp(t, dir, server);

  const { code } = await new Promise<{ code: number | null }>((resolve) => {
    server.process.once("exit", (code) => resolve({ code }));
  });

  assert.notEqual(code, 0);
  assert.equal(
    server.rawLines.some((line) => line.includes("listening")),
    false,
  );
  assert.ok(
    server.rawLines.some((line) => line.includes("KEPT_QUERY_PARAMS")),
    "the failure should name the variable that's misconfigured",
  );
});

test('logs a warning when KEPT_QUERY_PARAMS or KEPT_HASH_VALUES is "*"', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4230;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    KEPT_QUERY_PARAMS: "*",
    KEPT_HASH_VALUES: "*",
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  assert.equal(
    server.rawLines.filter((line) =>
      line.includes("every value is stored as the visitor"),
    ).length,
    2,
    "one warning per variable set to *",
  );
});

// The configured lists must reach the client script, not only the
// server. Otherwise the client would remove a parameter the owner wanted
// to keep, or send one they wanted removed.
test("serves /client.js with this deployment's own kept-parameter list embedded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4231;

  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    KEPT_QUERY_PARAMS: "gclid,utm_source",
    KEPT_HASH_VALUES: "pricing",
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const res = await fetch(`http://localhost:${port}/client.js`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!body.includes("__GENUG_KEPT_URL_PARTS__"));
  assert.ok(
    body.includes('{"params":["gclid","utm_source"],"hashes":["pricing"]}'),
  );
});
