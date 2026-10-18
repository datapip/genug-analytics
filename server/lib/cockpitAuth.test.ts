import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  createCockpitAuth,
  LOGIN_PATH,
  resetSessionRevocationForTests,
} from "./cockpitAuth.js";
import { COCKPIT_SESSION_COOKIE } from "./cockpitSession.js";
import { createFailedAttemptLimiter } from "./rateLimit.js";

// A real Express app on a real port, like routes/events.test.ts. The
// middleware answers with redirects, cookies and status codes, which a
// fake response object might not imitate correctly.
const PASSWORD = "hunter2";
const SALT = Buffer.alloc(16, 1);

const servers: ReturnType<express.Express["listen"]>[] = [];
after(() => {
  for (const server of servers) server.close();
});

function mountCockpit(
  limiter = createFailedAttemptLimiter(10, 60_000),
  password = PASSWORD,
  salt = SALT,
) {
  const auth = createCockpitAuth(password, salt, limiter);
  const app = express();
  app.use("/cockpit", auth.router);
  app.use("/cockpit", auth.requireSession);
  // Stands for everything behind the sign-in check (JSON routes and
  // files).
  app.use("/cockpit", (req, res) => {
    res.json({ reached: req.path });
  });

  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://localhost:${port}`;
}

const base = mountCockpit();

function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, { headers, redirect: "manual" });
}

async function signIn(
  origin: string,
  password: string = PASSWORD,
): Promise<Response> {
  return fetch(`${origin}/cockpit/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-genug-cockpit": "1",
    },
    body: JSON.stringify({ password }),
    redirect: "manual",
  });
}

// The cookie as a browser would send it back.
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "expected a Set-Cookie header");
  return header.split(";")[0]!;
}

test("the right password returns a session cookie with the flags that matter", async () => {
  const response = await signIn(base);
  assert.equal(response.status, 200);

  const header = response.headers.get("set-cookie") ?? "";
  assert.match(header, new RegExp(`^${COCKPIT_SESSION_COOKIE}=`));
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Lax/i);
  // Keeps the session cookie away from /events, which is public and
  // busy.
  assert.match(header, /Path=\/cockpit/i);
});

test("the wrong password is refused and sets no cookie", async () => {
  const response = await signIn(base, "not-the-password");

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a sign-in without the cockpit header is refused", async () => {
  const response = await fetch(`${base}/cockpit/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("a body with no password at all is refused, not crashed on", async () => {
  for (const body of ["{}", '{"password":123}', '{"password":null}']) {
    const response = await fetch(`${base}/cockpit/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-genug-cockpit": "1" },
      body,
    });
    assert.equal(response.status, 401, body);
  }
});

test("the cockpit is reachable with the cookie and not without it", async () => {
  const withoutCookie = await get(`${base}/cockpit/data`);
  assert.equal(withoutCookie.status, 401);

  const cookie = cookieFrom(await signIn(base));
  const withCookie = await get(`${base}/cockpit/data`, { cookie });
  assert.equal(withCookie.status, 200);
});

// The installation's salt must be used for the signing key, or two
// cockpits with the same password would accept each other's sessions.
test("a session from another install with the same password is refused", async () => {
  const elsewhere = mountCockpit(undefined, PASSWORD, Buffer.alloc(16, 2));

  const cookie = cookieFrom(await signIn(base));
  assert.equal((await get(`${base}/cockpit/data`, { cookie })).status, 200);
  assert.equal(
    (await get(`${elsewhere}/cockpit/data`, { cookie })).status,
    401,
  );
});

// fetch() sends `Accept: */*`, which matches text/html, so checking
// `req.accepts("html")` would answer every JSON call with the sign-in
// page. Sec-Fetch-Dest is checked instead.
test("a page navigation is redirected to the login page; a fetch gets a 401", async () => {
  const navigation = await get(`${base}/cockpit/`, {
    accept: "text/html,application/xhtml+xml",
    "sec-fetch-dest": "document",
  });
  assert.equal(navigation.status, 302);
  assert.equal(navigation.headers.get("location"), LOGIN_PATH);

  const call = await get(`${base}/cockpit/data`, {
    accept: "*/*",
    "sec-fetch-dest": "empty",
  });
  assert.equal(call.status, 401);
});

// Clients that send neither header (curl, a monitor, an old browser)
// get the status code, not the page, which is the safer choice.
test("a client that sends no Sec-Fetch-Dest gets the 401", async () => {
  assert.equal((await get(`${base}/cockpit/data`)).status, 401);
});

test("the login page and what it needs are reachable without a session", async () => {
  for (const path of [
    "/cockpit/login.html",
    "/cockpit/login.js",
    "/cockpit/cockpit.css",
    "/cockpit/theme.js",
    "/cockpit/favicon.svg",
  ]) {
    assert.equal((await get(`${base}${path}`)).status, 200, path);
  }
});

// A mistake in the list of public paths would make the cockpit public,
// so check how paths are matched, not only which are listed.
test("the allowlist does not admit the cockpit itself, or spellings of its own entries", async () => {
  for (const path of [
    "/cockpit/",
    "/cockpit/index.html",
    "/cockpit/data",
    // req.path stays percent-encoded while express.static decodes it, so
    // an encoded spelling must not match the list.
    "/cockpit/cockpit%2Ecss",
    "/cockpit/login.html/../index.html",
  ]) {
    assert.equal((await get(`${base}${path}`)).status, 401, path);
  }
});

test("an allowlisted path is public for GET only", async () => {
  const response = await fetch(`${base}/cockpit/login.html`, {
    method: "POST",
    redirect: "manual",
  });
  assert.equal(response.status, 401);
});

// A session made with one password isn't valid with another, so
// changing COCKPIT_PASSWORD signs everyone out (see also
// cockpitSession.test.ts).
test("a cookie signed under a different password is refused", async () => {
  const elsewhere = mountCockpit(
    createFailedAttemptLimiter(10, 60_000),
    "a-different-password",
  );
  const foreign = cookieFrom(await signIn(elsewhere, "a-different-password"));

  assert.equal(
    (await get(`${base}/cockpit/data`, { cookie: foreign })).status,
    401,
  );
});

test("logging out stops the cookie working", async (t) => {
  t.after(resetSessionRevocationForTests);
  const origin = mountCockpit();
  const cookie = cookieFrom(await signIn(origin));
  assert.equal((await get(`${origin}/cockpit/data`, { cookie })).status, 200);

  const loggedOut = await fetch(`${origin}/cockpit/logout`, {
    method: "POST",
    headers: { cookie, "x-genug-cockpit": "1" },
    redirect: "manual",
  });
  assert.equal(loggedOut.status, 200);
  assert.deepEqual(await loggedOut.json(), { ok: true, revoked: true });
  // Cleared with the same path and sameSite it was set with; otherwise
  // the browser keeps it.
  const cleared = loggedOut.headers.get("set-cookie") ?? "";
  assert.match(cleared, /Path=\/cockpit/i);
  assert.match(cleared, /SameSite=Lax/i);

  // The old cookie is refused even if it is sent again.
  assert.equal((await get(`${origin}/cockpit/data`, { cookie })).status, 401);

  // A session started after the sign-out must still work. If the
  // comparison of issuedAt with the sign-out time were wrong, the owner
  // would be locked out for good after the first sign-out.
  const newCookie = cookieFrom(await signIn(origin));
  assert.equal(
    (await get(`${origin}/cockpit/data`, { cookie: newCookie })).status,
    200,
  );
});

// The sign-out time applies to every browser, so only a valid session
// may set it; otherwise a script could keep the owner signed out.
test("a logout without a live session from the cockpit signs nobody else out", async (t) => {
  t.after(resetSessionRevocationForTests);
  const origin = mountCockpit();
  const cookie = cookieFrom(await signIn(origin));

  const attempts: Record<string, string>[] = [
    {},
    { "x-genug-cockpit": "1" },
    { "x-genug-cockpit": "1", cookie: `${COCKPIT_SESSION_COOKIE}=forged` },
    // A form on another site can send the cookie, but not the header.
    { cookie },
  ];
  for (const headers of attempts) {
    const response = await fetch(`${origin}/cockpit/logout`, {
      method: "POST",
      headers,
      redirect: "manual",
    });
    assert.equal(response.status, 200);
    // So the page doesn't claim every browser was signed out.
    assert.deepEqual(await response.json(), { ok: true, revoked: false });
    // Still clears this browser's cookie, so an old tab can sign out.
    assert.match(
      response.headers.get("set-cookie") ?? "",
      new RegExp(`^${COCKPIT_SESSION_COOKIE}=;`),
    );
    assert.equal(
      (await get(`${origin}/cockpit/data`, { cookie })).status,
      200,
      `session survived ${JSON.stringify(Object.keys(headers))}`,
    );
  }
});

// A cookie from before a sign-out still has a valid signature. It must
// not be able to sign out every browser again, or anyone with an old
// copy could keep the owner signed out.
test("a revoked cookie cannot sign out the session that replaced it", async (t) => {
  t.after(resetSessionRevocationForTests);
  const origin = mountCockpit();
  const old = cookieFrom(await signIn(origin));
  await fetch(`${origin}/cockpit/logout`, {
    method: "POST",
    headers: { cookie: old, "x-genug-cockpit": "1" },
  });
  const current = cookieFrom(await signIn(origin));

  const replay = await fetch(`${origin}/cockpit/logout`, {
    method: "POST",
    headers: { cookie: old, "x-genug-cockpit": "1" },
  });
  assert.deepEqual(await replay.json(), { ok: true, revoked: false });
  assert.equal(
    (await get(`${origin}/cockpit/data`, { cookie: current })).status,
    200,
  );
});

test("blocks further sign-ins once the failure limit is reached", async () => {
  const origin = mountCockpit(createFailedAttemptLimiter(3, 60_000));

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await signIn(origin, "nope");
    assert.equal(response.status, 401, `attempt ${attempt + 1}`);
  }

  const blocked = await signIn(origin, "nope");
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
});

// On purpose: a blocked address is refused before its password is
// checked, so even the right password doesn't help until the block
// ends. See lib/rateLimit.ts.
test("a blocked address is refused even with the right password", async () => {
  const origin = mountCockpit(createFailedAttemptLimiter(1, 60_000));
  await signIn(origin, "nope");

  const response = await signIn(origin);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("set-cookie"), null);
});

// The lockout only applies to signing in, not to every /cockpit request,
// so a blocked address with a valid session keeps working, and loading
// the page's files doesn't count.
test("the lockout does not touch a request that carries a session", async () => {
  const origin = mountCockpit(createFailedAttemptLimiter(1, 60_000));
  const cookie = cookieFrom(await signIn(origin));
  await signIn(origin, "nope");

  assert.equal((await signIn(origin, "nope")).status, 429);
  assert.equal((await get(`${origin}/cockpit/data`, { cookie })).status, 200);
});

test("a successful sign-in never consumes the failure budget", async () => {
  const origin = mountCockpit(createFailedAttemptLimiter(3, 60_000));

  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await signIn(origin)).status, 200);
  }
});
