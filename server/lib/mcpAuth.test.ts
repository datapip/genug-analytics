import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { createMcpAuthMiddleware } from "./mcpAuth.js";
import { createRequestLimiter } from "./rateLimit.js";

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

// Small budgets so a test can spend one in a few calls.
function smallLimiters(keyed: number, keyless: number) {
  return {
    keyed: createRequestLimiter(keyed, "/mcp"),
    keyless: createRequestLimiter(keyless, "/mcp keyless"),
  };
}

function call(
  middleware: ReturnType<typeof createMcpAuthMiddleware>,
  authorization: string | undefined,
  ip = "203.0.113.9",
) {
  const req = {
    headers: authorization === undefined ? {} : { authorization },
    ip,
  } as unknown as Request;
  const res = createMockRes();
  let nextCalled = false;
  middleware(req, res as unknown as Response, () => {
    nextCalled = true;
  });
  return { status: res.statusCode, nextCalled, res };
}

// The bug this fixes: claude.ai and other hosted agents share their
// addresses with the vendor's other customers. Before, ten wrong keys
// from any of them locked the owner's own connector out for fifteen
// minutes, and sixty keyless calls spent its request budget.
test("strangers on the owner's address cannot spend the owner's budget", () => {
  const middleware = createMcpAuthMiddleware("secret-key", smallLimiters(2, 3));

  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(call(middleware, "Bearer wrong-key").status, 401);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(call(middleware, "Bearer wrong-key").status, 429);
    assert.equal(call(middleware, undefined).status, 429);
  }

  const owner = call(middleware, "Bearer secret-key");
  assert.equal(owner.nextCalled, true);
  assert.equal(owner.status, undefined);
});

// The keyless budget is what bounds guessing, so a guess past it is
// refused before the key is compared. The response says so, and for
// how long, rather than a bare 401 that would invite another try.
test("guesses past the keyless budget are refused with a wait", () => {
  const middleware = createMcpAuthMiddleware(
    "secret-key",
    smallLimiters(60, 2),
  );

  call(middleware, "Bearer guess-1");
  call(middleware, "Bearer guess-2");
  const refused = call(middleware, "Bearer guess-3");

  assert.equal(refused.status, 429);
  assert.equal(refused.nextCalled, false);
  const retryAfter = Number(refused.res.headers["Retry-After"]);
  assert.ok(retryAfter >= 1 && retryAfter <= 60);
});

// The other half of the split: the key-holder's flood is still
// bounded, and spending it does not spend the keyless budget.
test("the owner's own budget is bounded separately", () => {
  const middleware = createMcpAuthMiddleware("secret-key", smallLimiters(2, 5));

  assert.equal(call(middleware, "Bearer secret-key").nextCalled, true);
  assert.equal(call(middleware, "Bearer secret-key").nextCalled, true);
  const third = call(middleware, "Bearer secret-key");
  assert.equal(third.status, 429);
  assert.equal(third.nextCalled, false);

  assert.equal(call(middleware, "Bearer wrong-key").status, 401);
});

test("budgets are kept per address", () => {
  const middleware = createMcpAuthMiddleware("secret-key", smallLimiters(1, 1));

  call(middleware, "Bearer secret-key", "203.0.113.9");
  assert.equal(
    call(middleware, "Bearer secret-key", "203.0.113.9").status,
    429,
  );
  assert.equal(
    call(middleware, "Bearer secret-key", "198.51.100.4").nextCalled,
    true,
  );
});
