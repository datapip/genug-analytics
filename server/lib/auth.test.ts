import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeStringEqual } from "./auth.js";

test("timingSafeStringEqual is true for identical strings", () => {
  assert.equal(timingSafeStringEqual("secret", "secret"), true);
});

test("timingSafeStringEqual is false for same-length different strings", () => {
  assert.equal(timingSafeStringEqual("secret", "secreT"), false);
});

test("timingSafeStringEqual is false for different-length strings", () => {
  assert.equal(timingSafeStringEqual("secret", "secrets"), false);
});

test("timingSafeStringEqual is false when either string is empty", () => {
  assert.equal(timingSafeStringEqual("", "secret"), false);
  assert.equal(timingSafeStringEqual("secret", ""), false);
});
