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
// middleware answers with redirects, cookies and status codes, and a
// hand-rolled mock response would be asserting against my own idea of
// what Express does rather than what it does.
const PASSWORD = "hunter2";

const servers: ReturnType<express.Express["listen"]>[] = [];
after(() => {
  for (const server of servers) server.close();
});

function mountCockpit(
  limiter = createFailedAttemptLimiter(10, 60_000),
  password = PASSWORD,
) {
  const auth = createCockpitAuth(password, limiter);
  const app = express();
  app.use("/cockpit", auth.router);
  app.use("/cockpit", auth.requireSession);
  // Stands in for the JSON router and the static files alike: anything
  // past the gate.
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
  // Keeps the owner's session off /events, which is public and busy.
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

// The failure that would have made every JSON call in the cockpit
// return a login page: fetch() sends `Accept: */*`, which matches
// text/html, so the obvious `req.accepts("html")` test answers a
// redirect here and the page reports a parse error instead of asking
// anyone to sign in.
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

// Anything that sends neither header — curl, a monitor, an old browser
// — gets the status code rather than the page. The safer of the two to
// be wrong about.
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

// The allowlist is the one place a mistake makes the whole cockpit
// public, so the shape of the match is worth pinning, not just its
// contents.
test("the allowlist does not admit the cockpit itself, or spellings of its own entries", async () => {
  for (const path of [
    "/cockpit/",
    "/cockpit/index.html",
    "/cockpit/data",
    // Express leaves req.path percent-encoded while express.static
    // decodes it, so an encoded spelling misses the set — and must fail
    // closed rather than be decoded to match.
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

// The deployment-level version of the rotation test in
// cockpitSession.test.ts: a session minted under one password is not a
// session under another, so changing COCKPIT_PASSWORD signs everyone
// out without a session store to clear.
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
  // Cleared with the same path and sameSite it was set with: a
  // clearCookie that disagrees about either silently clears nothing.
  const cleared = loggedOut.headers.get("set-cookie") ?? "";
  assert.match(cleared, /Path=\/cockpit/i);
  assert.match(cleared, /SameSite=Lax/i);

  // The copy the browser was told to drop is refused even when it is
  // sent anyway — which is what makes the button mean something.
  assert.equal((await get(`${origin}/cockpit/data`, { cookie })).status, 401);

  // The watermark that revokes the old cookie must not also catch the
  // next one: it compares issuedAt against the moment logout was
  // pressed, so a session started afterwards has to clear it. A
  // regression here (the comparison flipped, or the watermark stuck at
  // "always") would lock the owner out permanently after their first
  // logout, with nothing above catching it.
  const newCookie = cookieFrom(await signIn(origin));
  assert.equal(
    (await get(`${origin}/cockpit/data`, { cookie: newCookie })).status,
    200,
  );
});

// The watermark is global, so moving it signs every browser out. When
// an anonymous POST could move it, a loop of them locked the owner out
// for as long as it ran.
test("a logout without a live session from the cockpit signs nobody else out", async (t) => {
  t.after(resetSessionRevocationForTests);
  const origin = mountCockpit();
  const cookie = cookieFrom(await signIn(origin));

  const attempts: Record<string, string>[] = [
    {},
    { "x-genug-cockpit": "1" },
    { "x-genug-cockpit": "1", cookie: `${COCKPIT_SESSION_COOKIE}=forged` },
    // A cross-site form carries the cookie at most, never the header.
    { cookie },
  ];
  for (const headers of attempts) {
    const response = await fetch(`${origin}/cockpit/logout`, {
      method: "POST",
      headers,
      redirect: "manual",
    });
    assert.equal(response.status, 200);
    // Told the truth, so the page doesn't claim every browser is out.
    assert.deepEqual(await response.json(), { ok: true, revoked: false });
    // Still clears the caller's own cookie: a stale tab can sign out.
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

// A leaked cookie stays a valid signature after logout revokes it. If
// it could still move the watermark, replaying it would sign out every
// new session: the same lockout, for anyone holding an old copy.
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

// Deliberate, and inherited from the Basic Auth version: a blocked
// address is refused before its password is looked at, so the correct
// one does not rescue it until the window lapses. See lib/rateLimit.ts.
test("a blocked address is refused even with the right password", async () => {
  const origin = mountCockpit(createFailedAttemptLimiter(1, 60_000));
  await signIn(origin, "nope");

  const response = await signIn(origin);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("set-cookie"), null);
});

// The lockout now sits on one route instead of every request under
// /cockpit — so a locked-out address that already holds a valid session
// keeps working, and a page full of assets never spends the budget.
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
