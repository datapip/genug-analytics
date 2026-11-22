import { test } from "node:test";
import assert from "node:assert/strict";
import { isBotUserAgent } from "./bots.js";

test("isBotUserAgent is true for known crawlers and automation tools", () => {
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    ),
    true,
  );
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    ),
    true,
  );
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
    ),
    true,
  );
  assert.equal(isBotUserAgent("facebookexternalhit/1.1"), true);
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
    ),
    true,
  );
});

// Speed testers run a real browser, so they run the client script and
// each run would count as a visit.
test("isBotUserAgent is true for page-speed testers", () => {
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse",
    ),
    true,
  );
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 GTmetrix",
    ),
    true,
  );
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 PTST/240101.120000",
    ),
    true,
  );
});

// None of these runs the client script, so a request from one was
// posted to /events by hand or by a script.
test("isBotUserAgent is true for HTTP libraries and command-line tools", () => {
  for (const ua of [
    "curl/8.5.0",
    "Wget/1.21.4",
    "python-requests/2.31.0",
    "Python-urllib/3.12",
    "Go-http-client/2.0",
    "okhttp/4.12.0",
    "axios/1.6.7",
    "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "Java/17.0.9",
  ]) {
    assert.equal(isBotUserAgent(ua), true, ua);
  }
});

test("isBotUserAgent is true when the User-Agent header is missing", () => {
  assert.equal(isBotUserAgent(undefined), true);
});

// `bot` matches inside "CUBOT", an Android phone brand. Dropping those
// visitors would lose data unnoticed, which is worse than letting an
// occasional crawler through.
test("isBotUserAgent is false for a device whose model contains a bot pattern", () => {
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ),
    false,
  );
});

// In-app browsers append their own tokens, which is where a substring
// would match by accident. JavaFX sends "JavaFX/17": it stays a browser
// only because the pattern is "java/" with the slash.
test("isBotUserAgent is false for real browser User-Agent strings", () => {
  for (const ua of [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.105 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/454.0.0.42.111;]",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 325.0.0.35.91 (iPhone15,2; iOS 17_4; de_DE; de; scale=3.00; 1179x2556; 584340927)",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_34.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/de Region/DE",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) JavaFX/17 Safari/605.1.15",
  ]) {
    assert.equal(isBotUserAgent(ua), false, ua);
  }
});
