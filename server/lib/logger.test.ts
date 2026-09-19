import { test } from "node:test";
import assert from "node:assert/strict";
import { logInfo, logError } from "./logger.js";

// Captures what a call writes to the given console method, restoring it
// afterward — same "inject/observe, then restore" shape as any test that
// needs to intercept a global rather than a parameter (unlike this
// project's usual pattern of passing state in, e.g. rateLimit.ts's
// isWithinRateLimit, console methods aren't something callers can inject).
function captureConsole(method: "log" | "error", run: () => void): string {
  const original = console[method];
  let captured = "";
  console[method] = (line: string) => {
    captured = line;
  };
  try {
    run();
  } finally {
    console[method] = original;
  }
  return captured;
}

test("logInfo writes a single-line JSON object to console.log with level, msg, ts", () => {
  const line = captureConsole("log", () => {
    logInfo("genug server listening", { port: 3000 });
  });

  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "genug server listening");
  assert.equal(parsed.port, 3000);
  assert.equal(typeof parsed.ts, "string");
});

test("logInfo works without extra fields", () => {
  const line = captureConsole("log", () => {
    logInfo("Shutting down");
  });

  const parsed = JSON.parse(line);
  assert.equal(parsed.msg, "Shutting down");
});

test("logError writes to console.error, not console.log", () => {
  let logCalled = false;
  const errorLine = captureConsole("error", () => {
    const originalLog = console.log;
    console.log = () => {
      logCalled = true;
    };
    try {
      logError("Retention pruning failed", new Error("disk full"));
    } finally {
      console.log = originalLog;
    }
  });

  assert.equal(logCalled, false);
  const parsed = JSON.parse(errorLine);
  assert.equal(parsed.level, "error");
  assert.equal(parsed.msg, "Retention pruning failed");
});

test("logError serializes an Error's stack, not just [object Error]", () => {
  const line = captureConsole("error", () => {
    logError("Backup failed", new Error("disk full"));
  });

  const parsed = JSON.parse(line);
  assert.match(parsed.error, /disk full/);
});

test("logError stringifies a non-Error value thrown as-is", () => {
  const line = captureConsole("error", () => {
    logError("Something failed", "a plain string reason");
  });

  const parsed = JSON.parse(line);
  assert.equal(parsed.error, "a plain string reason");
});

test("logError keeps a multi-line stack trace on a single output line", () => {
  const error = new Error("boom");
  error.stack = "Error: boom\n    at foo\n    at bar";

  const line = captureConsole("error", () => {
    logError("Job failed", error);
  });

  assert.equal(line.includes("\n"), false);
  const parsed = JSON.parse(line);
  assert.equal(parsed.error, "Error: boom\n    at foo\n    at bar");
});

test("logError merges extra fields alongside the error", () => {
  const line = captureConsole("error", () => {
    logError("Job failed", new Error("boom"), { jobName: "retention" });
  });

  const parsed = JSON.parse(line);
  assert.equal(parsed.jobName, "retention");
});
