import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkRateLimit,
  createFailedAttemptLimiter,
  createRequestLimiter,
  rateLimitEvents,
} from "./rateLimit.js";

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 600;

test("checkRateLimit allows requests up to the per-window limit", () => {
  const hits = new Map();
  const now = Date.now();

  for (let i = 0; i < MAX_PER_WINDOW; i++) {
    assert.equal(
      checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW).allowed,
      true,
    );
  }
});

test("checkRateLimit blocks the request after the limit within the same window", () => {
  const hits = new Map();
  const now = Date.now();

  for (let i = 0; i < MAX_PER_WINDOW; i++) {
    checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW);
  }

  assert.equal(
    checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW).allowed,
    false,
  );
});

test("checkRateLimit tracks each IP separately", () => {
  const hits = new Map();
  const now = Date.now();

  for (let i = 0; i < MAX_PER_WINDOW; i++) {
    checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW);
  }

  // A different IP has its own, untouched budget.
  assert.equal(
    checkRateLimit(hits, "5.6.7.8", now, MAX_PER_WINDOW).allowed,
    true,
  );
});

test("checkRateLimit resets once the window has passed", () => {
  const hits = new Map();
  const start = Date.now();

  for (let i = 0; i < MAX_PER_WINDOW; i++) {
    checkRateLimit(hits, "1.2.3.4", start, MAX_PER_WINDOW);
  }
  assert.equal(
    checkRateLimit(hits, "1.2.3.4", start, MAX_PER_WINDOW).allowed,
    false,
  );

  assert.equal(
    checkRateLimit(hits, "1.2.3.4", start + WINDOW_MS + 1, MAX_PER_WINDOW)
      .allowed,
    true,
  );
});

// The middleware is what the routes mount, so the check that a refusal
// is a 429 and an allowed call reaches next() belongs at that level,
// with the express objects stubbed down to the three members it reads.
function fakeExchange(ip: string) {
  let status: number | undefined;
  let passed = false;
  let body: Record<string, unknown> | undefined;
  const headers: Record<string, string> = {};
  const req = { ip } as Parameters<ReturnType<typeof createRequestLimiter>>[0];
  const res = {
    set(name: string, value: string) {
      headers[name] = value;
      return res;
    },
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return res;
    },
  } as unknown as Parameters<ReturnType<typeof createRequestLimiter>>[1];
  const next = () => {
    passed = true;
  };
  return {
    req,
    res,
    next,
    headers,
    bodyOf: () => body,
    result: () => ({ status, passed }),
  };
}

test("createRequestLimiter passes calls through until its own ceiling, then answers 429", () => {
  const limiter = createRequestLimiter(3, "/test");

  for (let i = 0; i < 3; i++) {
    const x = fakeExchange("9.9.9.9");
    limiter(x.req, x.res, x.next);
    assert.deepEqual(x.result(), { status: undefined, passed: true });
  }

  const refused = fakeExchange("9.9.9.9");
  limiter(refused.req, refused.res, refused.next);
  assert.deepEqual(refused.result(), { status: 429, passed: false });
});

test("two limiters keep separate budgets", () => {
  const a = createRequestLimiter(1, "/a");
  const b = createRequestLimiter(1, "/b");

  const first = fakeExchange("9.9.9.9");
  a(first.req, first.res, first.next);
  const second = fakeExchange("9.9.9.9");
  a(second.req, second.res, second.next);
  assert.equal(second.result().status, 429);

  // /b has not seen this address at all.
  const other = fakeExchange("9.9.9.9");
  b(other.req, other.res, other.next);
  assert.equal(other.result().passed, true);
});

// The number itself, not just the mechanism: the tests above pass a
// limit in, so nothing else would notice /events' ceiling changing.
test("rateLimitEvents allows 600 a minute per address", () => {
  for (let i = 0; i < 600; i++) {
    const x = fakeExchange("7.7.7.7");
    rateLimitEvents(x.req, x.res, x.next);
    assert.equal(x.result().passed, true, `request ${i + 1}`);
  }

  const refused = fakeExchange("7.7.7.7");
  rateLimitEvents(refused.req, refused.res, refused.next);
  assert.equal(refused.result().status, 429);
});

test("createFailedAttemptLimiter blocks only after the failure limit", () => {
  const limiter = createFailedAttemptLimiter(3, 60_000);
  assert.equal(limiter.isBlocked("1.1.1.1", 0), false);

  limiter.recordFailure("1.1.1.1", 0);
  limiter.recordFailure("1.1.1.1", 10);
  assert.equal(limiter.isBlocked("1.1.1.1", 20), false, "2 of 3 failures");

  limiter.recordFailure("1.1.1.1", 30);
  assert.equal(limiter.isBlocked("1.1.1.1", 40), true, "3 of 3 failures");
});

test("createFailedAttemptLimiter tracks each IP separately", () => {
  const limiter = createFailedAttemptLimiter(1, 60_000);
  limiter.recordFailure("1.1.1.1", 0);

  assert.equal(limiter.isBlocked("1.1.1.1", 0), true);
  assert.equal(limiter.isBlocked("2.2.2.2", 0), false);
});

test("createFailedAttemptLimiter forgets failures once the window passes", () => {
  const limiter = createFailedAttemptLimiter(1, 60_000);
  limiter.recordFailure("1.1.1.1", 0);
  assert.equal(limiter.isBlocked("1.1.1.1", 0), true);

  assert.equal(limiter.isBlocked("1.1.1.1", 60_001), false);
});

// A failure arriving after the window has lapsed starts a fresh window
// rather than incrementing a stale count, so an attacker can't
// accumulate failures indefinitely across windows.
test("createFailedAttemptLimiter restarts the window on a late failure", () => {
  const limiter = createFailedAttemptLimiter(2, 60_000);
  limiter.recordFailure("1.1.1.1", 0);
  limiter.recordFailure("1.1.1.1", 60_001);

  assert.equal(limiter.isBlocked("1.1.1.1", 60_002), false, "count reset to 1");
});

// The middleware logs on this flag alone, so it has to be true exactly
// once per window. A runaway loop that kept setting it would write a log
// line per request, which is the failure this replaced.
test("checkRateLimit reports the first refusal in a window only once", () => {
  const hits = new Map();
  const now = Date.now();

  for (let i = 0; i < MAX_PER_WINDOW; i++) {
    assert.equal(
      checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW).firstRefusal,
      false,
    );
  }

  assert.deepEqual(checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW), {
    allowed: false,
    firstRefusal: true,
    retryAfterSeconds: 60,
  });
  assert.deepEqual(checkRateLimit(hits, "1.2.3.4", now, MAX_PER_WINDOW), {
    allowed: false,
    firstRefusal: false,
    retryAfterSeconds: 60,
  });

  // A fresh window can report its own first refusal again.
  const later = now + WINDOW_MS + 1;
  assert.equal(
    checkRateLimit(hits, "1.2.3.4", later, MAX_PER_WINDOW).allowed,
    true,
  );
  for (let i = 1; i < MAX_PER_WINDOW; i++)
    checkRateLimit(hits, "1.2.3.4", later, MAX_PER_WINDOW);
  assert.equal(
    checkRateLimit(hits, "1.2.3.4", later, MAX_PER_WINDOW).firstRefusal,
    true,
  );
});

// A bare 429 leaves an agent unable to tell this refusal, which clears
// within the minute, from the key lockout, which holds for fifteen.
test("a refused request carries Retry-After and a body saying how long", () => {
  const limiter = createRequestLimiter(1, "/test");

  const first = fakeExchange("8.8.8.8");
  limiter(first.req, first.res, first.next);

  const refused = fakeExchange("8.8.8.8");
  limiter(refused.req, refused.res, refused.next);

  assert.equal(refused.result().status, 429);
  const seconds = Number(refused.headers["Retry-After"]);
  assert.ok(seconds >= 1 && seconds <= 60, `Retry-After was ${seconds}`);
  assert.deepEqual(refused.bodyOf(), {
    error: "rate limit reached",
    retryAfterSeconds: seconds,
  });
});

// Keying on the full address would give one residential line as many
// budgets as it has addresses, which is effectively unlimited.
test("every address in one IPv6 block shares a request budget", () => {
  const limiter = createRequestLimiter(2, "/test");

  for (const ip of ["2001:db8:1:2::5", "2001:db8:1:9::ffff"]) {
    const allowed = fakeExchange(ip);
    limiter(allowed.req, allowed.res, allowed.next);
    assert.equal(allowed.result().passed, true, ip);
  }

  const refused = fakeExchange("2001:db8:1:abcd::1");
  limiter(refused.req, refused.res, refused.next);
  assert.equal(refused.result().status, 429, "third address in the same block");

  // A different block still has its own budget.
  const elsewhere = fakeExchange("2001:db8:2::1");
  limiter(elsewhere.req, elsewhere.res, elsewhere.next);
  assert.equal(elsewhere.result().passed, true);
});

// The same hole, where it mattered most: this limiter is the only
// thing bounding guesses at the cockpit password and the MCP key.
test("createFailedAttemptLimiter counts one IPv6 block as one guesser", () => {
  const limiter = createFailedAttemptLimiter(2, 60_000);

  limiter.recordFailure("2001:db8:1:2::5", 0);
  limiter.recordFailure("2001:db8:1:9::ffff", 10);

  assert.equal(limiter.isBlocked("2001:db8:1:abcd::1", 20), true);
  assert.equal(limiter.isBlocked("2001:db8:2::1", 20), false, "another block");
});

test("createFailedAttemptLimiter keeps IPv4 addresses apart", () => {
  const limiter = createFailedAttemptLimiter(1, 60_000);
  limiter.recordFailure("203.0.113.5", 0);

  assert.equal(limiter.isBlocked("203.0.113.5", 0), true);
  assert.equal(limiter.isBlocked("203.0.113.6", 0), false);
});

test("createFailedAttemptLimiter reports the time left on a block", () => {
  const limiter = createFailedAttemptLimiter(1, 60_000);
  assert.equal(limiter.retryAfterSeconds("1.1.1.1", 0), 0, "not blocked yet");

  limiter.recordFailure("1.1.1.1", 0);
  assert.equal(limiter.retryAfterSeconds("1.1.1.1", 0), 60);
  assert.equal(limiter.retryAfterSeconds("1.1.1.1", 30_000), 30);
  assert.equal(limiter.retryAfterSeconds("1.1.1.1", 60_001), 0, "window past");

  // The block is still on at the last millisecond of the window, so a
  // Retry-After of 0 would invite a retry that is still refused.
  assert.equal(limiter.isBlocked("1.1.1.1", 60_000), true);
  assert.equal(limiter.retryAfterSeconds("1.1.1.1", 60_000), 1);
});
