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

// These tests spawn the real compiled server (dist/index.js) as a
// subprocess instead of importing index.ts directly — its startup logic
// is a side-effecting top-level script (routes mounted, background jobs
// scheduled, app.listen called), not something with an exported function
// to call. Rewriting it into one just to unit-test it would risk
// introducing a bug into code that's already been manually verified
// multiple times — this project's own style already leans toward
// integration-realism over mocking (real SQLite everywhere, no ORM), so
// a real subprocess against a real temp database fits that better than
// a refactor would. The cost: these are slower than this project's other
// (in-process) tests, and — unlike the setInterval-scheduled recurring
// runs — can only observe what happens at startup/shutdown, not a job
// firing again hours or a day later.
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

// Stop the server before removing its data directory, in that order.
// The child holds the SQLite file open, and Windows refuses to remove a
// directory that still has open handles inside it; on POSIX the same
// ordering is invisible, since unlinking an open file is legal there.
// These used to be two separate `t.after` hooks, which run in
// registration order — so the directory went first, the EPERM it threw
// skipped every remaining hook, and the server was left running while
// the test run hung waiting on the orphan.
function stopAndCleanUp(t: TestContext, dir: string, server: RunningServer) {
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
}

// The cockpit is behind a session cookie, so a test that talks to it
// signs in first, exactly as the page does. Returns the cookie in the
// form a browser sends it back.
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
    MCP_API_KEY: "test-key",
    COCKPIT_PASSWORD: "test-cockpit-password",
    ALLOWED_ORIGIN: `http://localhost:${port}`,
    LOCAL_BACKUPS: "false",
    // Beside DB_PATH, and for a blunter reason than tidiness: the
    // server seeds this directory at startup, so a spawned server
    // without it set reaches for the real /data/context on the machine
    // running the suite. That is an EACCES here and a directory
    // genuinely created there on anything running as root.
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

// The cockpit used to be readable by anyone when COCKPIT_PASSWORD was
// unset. Refusing to boot is what makes that impossible to end up with
// by accident, so it's worth pinning against the real entrypoint rather
// than trusting the middleware unit tests alone.
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
});

// cockpitAuth and requireApiKey are thoroughly unit-tested on their own,
// but nothing asserted they are actually mounted in front of the things
// they guard. Reordering two lines in index.ts — an ordinary edit when
// adding a route — would leave every one of those unit tests green while
// /cockpit/data served raw event URLs and props, and /mcp exposed every
// query tool plus delete_visitor_data, at a predictable public hostname.
// The only place that can catch it is the real assembled app.
test("keeps the guarded routes behind their auth, not just beside it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4204;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;

  // The JSON route and the static page are mounted separately, so each
  // needs its own check — guarding only one of them is a plausible slip.
  assert.equal((await fetch(`${base}/cockpit/data`)).status, 401);
  assert.equal((await fetch(`${base}/cockpit/index.html`)).status, 401);
  // Not a read: this one changes which events the server accepts.
  assert.equal(
    (
      await fetch(`${base}/cockpit/reload`, {
        method: "POST",
        headers: { "X-Genug-Cockpit": "1" },
      })
    ).status,
    401,
  );

  // And a session actually opens both, or a cockpit that refused
  // everything would satisfy the three checks above while being broken.
  const cookie = await signInToCockpit(port);
  assert.equal(
    (await fetch(`${base}/cockpit/data`, { headers: { cookie } })).status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/cockpit/index.html`, { headers: { cookie } })).status,
    200,
  );

  const mcpBody = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  };
  assert.equal((await fetch(`${base}/mcp`, mcpBody)).status, 401);

  // And the key actually opens it — otherwise a route that rejects
  // everything would pass the checks above while being broken.
  const authorized = await fetch(`${base}/mcp`, {
    ...mcpBody,
    headers: {
      ...mcpBody.headers,
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key",
    },
  });
  assert.notEqual(authorized.status, 401);
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

// RETENTION_DAYS=-1 is the explicit way to ask for what unset used to
// mean by default — a deployment that actually wants to keep
// everything now has to say so, since omitting the setting no longer
// says it for them.
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

  // No pruning ran, and no log claims RETENTION_DAYS is unset — it was
  // set, deliberately, to the value that means "don't".
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

// The startup log for an unset RETENTION_DAYS is covered separately, by
// message text alone — that proves the server *says* 396 days, not that
// it actually prunes to that boundary. A deployment upgrading from a
// version where unset meant forever hits exactly this path on its next
// restart, so it is the one behavior change in this release with real
// data-loss consequence if the wiring slipped.
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

  // No RETENTION_DAYS at all — baseEnv doesn't set it — is the point.
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
  // Windows has no POSIX signals: child.kill("SIGTERM") maps to
  // TerminateProcess, which kills the child outright rather than
  // delivering anything the process could handle. So the graceful path
  // this test exists to check can't run at all there — the child exits
  // with code null, never having seen a signal. Skipped rather than
  // weakened, since the behaviour it covers is real everywhere the
  // server is actually deployed (Linux containers).
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

// Unset now defaults to a real number of days rather than forever, but
// silently applying even a sensible default is still the wrong way to
// do it — a deployer upgrading from a version where unset meant forever
// should not have to infer the change from nothing happening.
test("says so at startup when RETENTION_DAYS is unset", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));

  const server = spawnServer(baseEnv(join(dir, "test.db"), 4210));
  stopAndCleanUp(t, dir, server);

  const line = await server.waitForLog((l) => l.msg.includes("RETENTION_DAYS"));
  assert.match(line.msg, /defaulting to 396 days/);
  assert.match(line.msg, /RETENTION_DAYS=-1/);
});

// The flip side: a deployment that has configured retention shouldn't be
// nagged about it on every restart.
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

// The salt is random and lives in a file beside the database. If that
// file stopped being read at startup, every deploy would split each
// visitor on the site into two, and nothing else would fail.
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
  // 0600 is covered in lib/dailySalt.test.ts; here only that it sits
  // beside the database, where the deployment docs say it is.
  assert.ok(existsSync(join(dir, "daily-salt.json")));
});

// The container runs as an unprivileged user, so the most likely
// deployment failure is a data directory it can't write to — a
// bind-mounted host directory keeps the host's ownership. better-sqlite3
// alone says only "unable to open database file", which doesn't point
// anywhere useful.
test("explains an unwritable data directory instead of just failing", async (t) => {
  // Windows has no equivalent of a mode-0500 directory — chmod is a
  // no-op there, so the server would open the database happily and
  // there'd be nothing to observe. Same for root, which ignores the
  // mode entirely. CI runs as a normal user on Linux (ubuntu-latest,
  // no container), so this is only skipped on a developer's machine.
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
  // Its own hook rather than stopAndCleanUp: the mode has to be
  // restored before the directory can be removed at all.
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

// The whole point of the reload, end to end and against the real
// entrypoint: a file that did not exist when the server booted starts
// being accepted without restarting anything. The pieces are unit-tested
// separately, but only the assembled app can show that the live binding
// actually reaches the request handler that validates an incoming event
// — which is the assumption the whole design rests on.
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

  // Startup seeded the volume with the built-ins, so this name is
  // genuinely unknown rather than merely unloaded.
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

  // Still unknown until something tells the server to look again.
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

// A reload is a state change behind a cookie-free, browser-cached
// credential, so the header is what tells a request from this page apart
// from a form on someone else's. Worth pinning: it is one line in the
// route and nothing else would fail if it were deleted.
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

// A session cookie is not the password, so a stolen one must not be a
// way to test guesses at it. Five wrong confirmations in a row sign
// every session out. Each one also counts toward the sign-in lockout
// for its address, so ten lock that address out of signing in too.
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

  // Two rounds of five: each round ends in a sign-out.
  for (let round = 0; round < 2; round++) {
    const cookie = await signInToCockpit(port);
    for (let i = 0; i < 4; i++) {
      // Stays 403: a 401 would send the owner to the sign-in page.
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

  // Ten failures from this address: sign-in is locked, even with the
  // right password.
  const signIn = await fetch(`${base}/cockpit/session`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-genug-cockpit": "1" },
    body: JSON.stringify({ password: "test-cockpit-password" }),
  });
  assert.equal(signIn.status, 429);
  assert.ok(signIn.headers.get("retry-after"));
});

// The create route's counterpart to the reload test above, and the same
// assumption under test: the event a form just defined is accepted by
// the collector immediately, with nothing else called in between. The
// route reloads the registry itself — without that, a creation would
// look like it worked and the next event under that name would still be
// rejected.
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

// Same reasoning as the reload guard: creating an event writes a file
// and changes what the collector accepts, so it may only be asked for
// by the cockpit page itself.
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

// A deployment whose EVENTS_PATH could not be seeded serves the image's
// events. A write there would be lost on the next deploy, so every
// event write answers 409 rather than saving into the image.
test("refuses event writes while events are read from the image", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4228;

  // The seeder never creates a missing parent, so this path is not used.
  const server = spawnServer({
    ...baseEnv(join(dir, "test.db"), port),
    EVENTS_PATH: join(dir, "missing", "events"),
  });
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const base = `http://localhost:${port}`;
  const auth = await signInToCockpit(port);

  const page = (await (
    await fetch(`${base}/cockpit/data?days=7`, { headers: { cookie: auth } })
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

// The stand-in only exists for a deployment that has edited its own
// event files, which is exactly what a published image produces — and
// it is the branch that keeps a typo in one file from taking the whole
// server down. Nothing covered it.
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

  // Renamed away *and* stripped of its tag: the built-in name is free,
  // so the stand-in can take it. (A rename that keeps the tag is the
  // ordinary case, tested below — this is the mistake.)
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

  // The client sends the role, never a name, so this is what a real
  // page view looks like arriving during the mistake.
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

// The claim in routes/cockpit.ts is that a failed rebuild is discarded
// whole and the running registry keeps collecting. Nothing checked the
// second half, which is the half that matters to a live site.
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

  // The tag dropped but the name kept: nothing carries pageView, and
  // the stand-in cannot take a name that is already registered, so the
  // build throws rather than returning a registry with no page view.
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

// The route that moves stored rows had no test at any level. The risk
// is specific: a rename that reports movedRows while the collector
// still resolves the role to the old name, which reads as a successful
// rename and silently drops every page view after it.
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

  // The tag moved with the file, so the role still resolves — to the
  // new name now. This is the assertion the whole test exists for.
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

  // The rename is also written into the history log, which is where the
  // agent looks before blaming a change in the numbers on the website.
  // Asserted here rather than only in lib/autoHistory.test.ts because
  // the route passes no directory: it uses the CONTEXT_PATH constant,
  // and nothing below the process boundary can tell that apart from a
  // hardcoded path that happens not to exist on this machine.
  const history = JSON.parse(
    readFileSync(join(dir, "context", "history.json"), "utf8"),
  ) as { from: string; note: string }[];
  assert.equal(history.length, 1);
  assert.equal(history[0]!.from, new Date().toISOString().slice(0, 10));
  assert.match(
    history[0]!.note,
    /^Recorded automatically: the event "page_view" was renamed to "seitenaufruf"\. 1 stored event moved to the new name\. Reason given: The site is German now$/,
  );

  // And it reaches the agent as part of the document it is told to read
  // — the file being right is only half of it.
  const resource = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key",
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

  // The numbers the agent reads. Every page-view metric resolves the
  // tagged event at query time; one that kept "page_view" would count
  // neither view here and report a quiet day rather than an error.
  const today = new Date().toISOString().slice(0, 10);
  const callTool = async (name: string) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-key",
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
  assert.deepEqual(pages.items, [{ path: "/", views: 2 }]);
});

// Deleting the event tagged _pageView is safe exactly when the
// built-in's own name is free to take it back — this is that case, and
// it should behave like an ordinary successful delete: 200, and page
// views keep being recorded (now under the stand-in's shape).
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

  // One real row before the delete, so the history entry below has
  // something it could wrongly claim was stranded.
  assert.equal((await sendPageView()).status, 204);

  const deleted = await fetch(`${base}/cockpit/events/page_view`, {
    method: "DELETE",
    headers: {
      cookie: auth,
      "content-type": "application/json",
      "X-Genug-Cockpit": "1",
    },
    // A DELETE with a body: the only one here, and the reason is the
    // only thing it ever carries.
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

  // The stand-in took the name back, so those rows still match a
  // registered event and nothing was stranded. Saying otherwise would
  // hand the agent a cause for a drop that never happened — in the file
  // it reads to explain drops.
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

// The page_view tests above both land in the stand-in special case,
// where the built-in takes the name back and nothing is stranded. This
// is the ordinary case strandedAfterReload() exists for: a deployment's
// own event, left behind on purpose (renameStoredEvents: false), with
// nothing waiting to reabsorb its name.
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
    // The 3 built-ins plus this deployment's own event: renaming
    // replaces the file, it does not remove one.
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

  // The old name has no registered event to match it any more, so its
  // row shows up as orphaned rather than silently vanishing from the
  // total — the failure this whole invariant exists to avoid.
  assert.equal(data.orphanedEvents.length, 1);
  assert.equal(data.orphanedEvents[0]!.event, "order_completed");
  assert.equal(data.orphanedEvents[0]!.events, 1);
  // storedEventCounts is a raw group-by over every row ever stored,
  // registered or not — that is what lets it flag the stranding above
  // in the first place. The row is still under the old name; nothing
  // was ever stored under the new one.
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

// The crash risk an earlier version of this route had: unlinking the
// file before finding out whether the registry can still build without
// it. Set up the one state where it cannot (the built-in's own name
// already taken by an untagged file, same as "keeps collecting when a
// reload fails" above) and delete the *other* event, the one actually
// carrying the tag.
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

  // Renamed but kept the tag (unlike the stand-in test above), and an
  // untagged file put back at the built-in's own name — so deleting
  // "seitenaufruf" would leave nothing tagged and nowhere for the
  // stand-in to go.
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

  // And nothing was written down claiming the delete happened. The
  // history call sits after this branch's early return on purpose, and
  // moving it "next to the deletion, where it belongs" would leave a
  // permanent line about an event that is still registered.
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

// ~16 queries plus the registry, the orphan scan and the tool manifest,
// composed in one handler: a throw anywhere in it blanks the whole
// page. An empty database is what a fresh deployment sees first, so
// that is the shape worth pinning.
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
  ]) {
    assert.ok(key in data, `/cockpit/data is missing ${key}`);
  }
});

// End to end: a real save reaches the file CONTEXT_PATH points at, and
// a real add lands in history.json in the shape appendHistoryEntry
// produces — the same three files lib/context.ts composes into the MCP
// resource the agent reads.
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

  // /cockpit/data reflects both, read fresh rather than from a cache
  // the writes above would have to know to invalidate.
  const page = (await (
    await fetch(`${base}/cockpit/data?days=7`, { headers: { cookie: auth } })
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

// Ordinary prose survives round-tripping through JSON at roughly 1 byte
// per character, but a `"` costs 2 once escaped (`\"`) — so content
// right at MAX_PROSE_FIELD_BYTES made entirely of quotes doubles in
// size on the wire. This pins that the request body's size limit has
// enough headroom over the content cap for that to still arrive as an
// ordinary save rather than being rejected by the body parser before
// writeGroundRules's own friendly error ever runs.
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

// The cockpit's danger-zone button, end to end: a real event lands, the
// route is asked to wipe it while confirming the password wrong, then
// right, and only the second call actually empties the database.
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
  // 403, not 401. The session is fine — it is the retyped confirmation
  // that is wrong — and cockpit.js reads a 401 as "the session ran out"
  // and leaves for the login page, so answering one here would throw
  // the owner out of the cockpit over a typo in a form field.
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

// Same CSRF story as /cockpit/reload — the one route on this page that
// deletes data must not be reachable from a plain cross-site form POST.
// SameSite=Lax already withholds the session cookie from one; this is
// the second lock, and the one that still holds if the cookie's flags
// are ever loosened.
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

// The other danger-zone button: it puts the events directory back to
// what the image ships, which is the one action that can strand stored
// rows under a name the registry no longer has.
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

  // A deployment's own event, registered and then collected under.
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
  // Nothing touched by a refused attempt.
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
    // The row collected under the removed name is still in the
    // database, and now belongs to no registered event.
    stranded: [{ event: "order_completed", count: 1 }],
  });

  assert.ok(!readdirSync(eventsPath).includes("order_completed.json"));

  // Written down too, with both numbers — and they come from different
  // places (files replaced, rows stranded), so a swap between them is
  // the mistake this asserts against rather than just "a line exists".
  const history = JSON.parse(
    readFileSync(join(dir, "context", "history.json"), "utf8"),
  ) as { note: string }[];
  assert.equal(history.length, 1);
  assert.match(history[0]!.note, /replacing 4 files/);
  assert.match(history[0]!.note, /order_completed \(1\)/);

  // The registry is live again without a restart, and the orphaned row
  // is reported where the cockpit shows it.
  const data = (await (
    await fetch(`${base}/cockpit/data?days=7`, {
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

// The mode a public demo runs in. Three things have to be true at once
// and each lives in a different file — the tool list (mcp/tools.ts), the
// cockpit's write refusal (routes/cockpit.ts) and the startup line
// (index.ts) — so this checks the running process rather than any one
// of them.
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

  // The transport answers a JSON-RPC POST as a server-sent event
  // stream, one `data:` line carrying the response.
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-key",
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
  // Writes nothing, but returns raw rows instead of an aggregate.
  assert.ok(!names.includes("get_recent_events"));

  // Every write route, with the CSRF header and the password a real
  // page would send, so the refusal can only be the mode.
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

  // Reads still work, and the page is told which mode it is in.
  const page = (await (
    await fetch(`${base}/cockpit/data?days=7`, {
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

  // Collection is not a write in this sense: the demo's own traffic is
  // the data.
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

// The limiter is mounted ahead of the key check, so a burst is refused
// whether or not it carries the key; a valid key is used here so the
// 429 can only be the request limit, not the failed-attempt lockout.
test("rate limits /mcp per address, before the key is checked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "genug-wiring-"));
  const port = 4219;

  const server = spawnServer(baseEnv(join(dir, "test.db"), port));
  stopAndCleanUp(t, dir, server);
  await server.waitForLog((line) => line.msg === "genug server listening");

  const request = (key = "test-key") =>
    fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  for (let i = 0; i < 60; i++) {
    assert.equal((await request()).status, 200, `request ${i + 1}`);
  }

  const refused = await request();
  assert.equal(refused.status, 429);
  // Through the real stack, not just the middleware: an agent has to be
  // able to tell this refusal from the key lockout, which lasts fifteen
  // minutes rather than under one.
  const retryAfter = Number(refused.headers.get("retry-after"));
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
  assert.deepEqual(await refused.json(), {
    error: "rate limit reached",
    retryAfterSeconds: retryAfter,
  });

  // The order, not just the ceiling: a wrong key inside a spent window
  // is answered 429 by the limiter, not 401 by the key check. Moving
  // the limiter behind the key check would turn this into a 401 while
  // every other assertion here still passed. One bad key is far below
  // the 10-failure lockout, so the 429 can only be the request limit.
  assert.equal((await request("wrong-key")).status, 429);

  const line = await server.waitForLog((l) => l.msg === "rate limit reached");
  assert.equal(line.route, "/mcp");
  assert.equal(line.limit, 60);
});

// One allowed request must be one JSON-RPC message. The transport
// itself accepts an array, so without the guard in routes/mcp.ts a
// single request inside the limit carries hundreds of tool calls and
// the per-minute ceiling above bounds almost nothing.
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
      authorization: "Bearer test-key",
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

// lib/context.test.ts proves what the document says in each state, but
// every one of its cases passes a directory in. Nothing there — and
// nothing in mcp/tools.test.ts, which reads the resource with the
// module default and so exercises the ENOENT fallback on a machine with
// no /data — can tell "served the owner's file" from "served the
// built-in because it never found the file". This can: the server seeds
// a real directory, the file is then changed underneath it, and the
// resource is read over HTTP.
//
// It covers the no-caching decision at the same time. lib/context.ts
// re-reads per request deliberately, and a module-level constant would
// be the easy, silent regression — the edit below happens after the
// process is up, so a cached read fails here and nowhere else.
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

  // Both written after startup on purpose, so only a per-request read
  // can return them.
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
      authorization: "Bearer test-key",
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
  // The two ways this could pass while being wrong: serving the
  // built-in text instead, or serving the fallback that says it found
  // nothing. Both would satisfy an assertion on the heading alone.
  assert.equal(document.includes("Ask rather than guess"), false);
  assert.equal(document.includes("There is no file at"), false);
  assert.equal(document.includes("No events have been recorded"), false);
});

// lib/history.test.ts proves the append itself, but every case there
// passes a path in. The tool passes none: it builds one from the
// contextPath module constant, which is read from the environment at
// import. Nothing below the process boundary can tell that constant
// apart from a hardcoded /data/context, and on this machine both fail
// the same way. So the round trip is worth running whole — write over
// MCP, then read the document back over MCP and find the note in it.
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
        authorization: "Bearer test-key",
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
  // The tool must say what it wrote rather than just succeeding — a note
  // recorded with a date the agent did not intend is repeated as fact
  // for as long as the file exists.
  assert.match(
    written.result.content![0]!.text,
    /Ran a discount campaign on the pricing page\./,
  );

  // A second call, for two reasons one call cannot cover. It pins that
  // the tool appends: writing `[entry]` over whatever is there passes an
  // assertion on a one-element array identically. And it is the common
  // shape — a single day, no end_date — which the handler passes through
  // as `to: undefined`, so this is what proves the stored entry gains no
  // `"to": null` and the document renders one date rather than a range.
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

  // A refusal has to reach the agent as a refusal. Reporting a note as
  // recorded when nothing was written is this project's worst shape of
  // failure — the owner believes the cause is written down, and every
  // later session reads a log that does not have it. The date is the one
  // Date.parse would wave through.
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
