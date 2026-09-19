import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createMcpAuthMiddleware } from "./mcpAuth.js";
import { createFailedAttemptLimiter } from "./rateLimit.js";

function createMockRes() {
  return {
    statusCode: undefined as number | undefined,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

test("rejects a request with no Authorization header", () => {
  const middleware = createMcpAuthMiddleware("secret-key");
  const req = { headers: {} } as Request;
  const res = createMockRes();
  let nextCalled = false;

  middleware(req, res as unknown as Response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("rejects an incorrect key", () => {
  const middleware = createMcpAuthMiddleware("secret-key");
  const req = {
    headers: { authorization: "Bearer wrong-key" },
  } as Request;
  const res = createMockRes();
  let nextCalled = false;

  middleware(req, res as unknown as Response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("accepts the correct key", () => {
  const middleware = createMcpAuthMiddleware("secret-key");
  const req = {
    headers: { authorization: "Bearer secret-key" },
  } as Request;
  const res = createMockRes();
  let nextCalled = false;

  middleware(req, res as unknown as Response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
});

test("rejects a non-Bearer Authorization scheme", () => {
  const middleware = createMcpAuthMiddleware("secret-key");
  const req = {
    headers: {
      authorization: `Basic ${Buffer.from(":secret-key").toString("base64")}`,
    },
  } as Request;
  const res = createMockRes();
  let nextCalled = false;

  middleware(req, res as unknown as Response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("blocks further attempts once the failure limit is reached", () => {
  const limiter = createFailedAttemptLimiter(3, 60_000);
  const middleware = createMcpAuthMiddleware("secret-key", limiter);
  const wrong = {
    headers: { authorization: "Bearer wrong-key" },
    ip: "203.0.113.9",
  } as unknown as Request;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = createMockRes();
    middleware(wrong, res as unknown as Response, () => {});
    assert.equal(res.statusCode, 401, `attempt ${attempt + 1} should be 401`);
  }

  const res = createMockRes();
  middleware(wrong, res as unknown as Response, () => {});
  assert.equal(res.statusCode, 429, "the attempt past the limit is throttled");
});

// The bug this guards against: a request with no Authorization header at
// all is the normal shape of an unauthenticated caller hitting a public
// endpoint, not a guess at the key. Before this guard existed, every one
// of these counted as a failed attempt — so ten bare POSTs from anyone,
// no key required, locked the site owner's own agent out of MCP for
// fifteen minutes, repeatably.
test("many requests with no Authorization header never trigger the lockout", () => {
  const limiter = createFailedAttemptLimiter(3, 60_000);
  const middleware = createMcpAuthMiddleware("secret-key", limiter);
  const bare = { headers: {}, ip: "203.0.113.9" } as unknown as Request;

  for (let attempt = 0; attempt < 20; attempt++) {
    const res = createMockRes();
    middleware(bare, res as unknown as Response, () => {});
    assert.equal(res.statusCode, 401, `attempt ${attempt + 1} should be 401`);
  }

  // The real key still works afterwards — the budget was never spent.
  const res = createMockRes();
  let nextCalled = false;
  middleware(
    {
      headers: { authorization: "Bearer secret-key" },
      ip: "203.0.113.9",
    } as unknown as Request,
    res as unknown as Response,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
});

// The point of counting failures rather than requests: a successful
// request never consumes any of the budget, so ordinary use can't
// throttle itself however heavy it gets.
test("successful auth never consumes the failure budget", () => {
  const limiter = createFailedAttemptLimiter(3, 60_000);
  const middleware = createMcpAuthMiddleware("secret-key", limiter);
  const right = {
    headers: { authorization: "Bearer secret-key" },
    ip: "203.0.113.9",
  } as unknown as Request;

  for (let attempt = 0; attempt < 20; attempt++) {
    const res = createMockRes();
    let nextCalled = false;
    middleware(right, res as unknown as Response, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, undefined);
  }
});

test("throttling is tracked per IP, not globally", () => {
  const limiter = createFailedAttemptLimiter(2, 60_000);
  const middleware = createMcpAuthMiddleware("secret-key", limiter);
  const attackerReq = {
    headers: { authorization: "Bearer wrong-key" },
    ip: "203.0.113.9",
  } as unknown as Request;

  for (let attempt = 0; attempt < 2; attempt++) {
    middleware(attackerReq, createMockRes() as unknown as Response, () => {});
  }

  const blocked = createMockRes();
  middleware(attackerReq, blocked as unknown as Response, () => {});
  assert.equal(blocked.statusCode, 429);

  // A different caller is unaffected by the attacker's failures.
  const innocent = createMockRes();
  let nextCalled = false;
  middleware(
    {
      headers: { authorization: "Bearer secret-key" },
      ip: "198.51.100.4",
    } as unknown as Request,
    innocent as unknown as Response,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
});

// Pins the lockout semantics above: a blocked IP is refused before its
// credentials are examined, so the correct key does not rescue it until
// the window lapses.
test("a blocked IP is refused even with the correct key", () => {
  const limiter = createFailedAttemptLimiter(1, 60_000);
  const middleware = createMcpAuthMiddleware("secret-key", limiter);

  middleware(
    {
      headers: { authorization: "Bearer wrong-key" },
      ip: "203.0.113.9",
    } as unknown as Request,
    createMockRes() as unknown as Response,
    () => {},
  );

  const res = createMockRes();
  let nextCalled = false;
  middleware(
    {
      headers: { authorization: "Bearer secret-key" },
      ip: "203.0.113.9",
    } as unknown as Request,
    res as unknown as Response,
    () => {
      nextCalled = true;
    },
  );

  assert.equal(res.statusCode, 429);
  assert.equal(nextCalled, false);
});
