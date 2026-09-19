import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUserAgent } from "./userAgent.js";

test("classifyUserAgent identifies Chrome on desktop Windows", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    { browser: "Chrome", deviceType: "desktop" },
  );
});

test("classifyUserAgent identifies Safari on desktop macOS", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ),
    { browser: "Safari", deviceType: "desktop" },
  );
});

test("classifyUserAgent identifies Firefox on desktop Linux", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0",
    ),
    { browser: "Firefox", deviceType: "desktop" },
  );
});

test("classifyUserAgent identifies Edge, not Chrome, despite Edge UAs containing Chrome/", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
    ),
    { browser: "Edge", deviceType: "desktop" },
  );
});

test("classifyUserAgent identifies mobile Safari on iPhone", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    { browser: "Safari", deviceType: "mobile" },
  );
});

test("classifyUserAgent identifies mobile Chrome on Android", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ),
    { browser: "Chrome", deviceType: "mobile" },
  );
});

test("classifyUserAgent identifies tablet Safari on iPad, not mobile", () => {
  assert.deepEqual(
    classifyUserAgent(
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    { browser: "Safari", deviceType: "tablet" },
  );
});

test("classifyUserAgent reports deviceType 'other' (not 'desktop') for a smart TV", () => {
  const result = classifyUserAgent(
    "Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/6.0 TV Safari/537.36",
  );
  assert.equal(result.deviceType, "other");
});

test("classifyUserAgent returns Other/other for a missing User-Agent", () => {
  assert.deepEqual(classifyUserAgent(null), {
    browser: "Other",
    deviceType: "other",
  });
});
