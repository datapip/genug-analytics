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

test("isBotUserAgent is true when the User-Agent header is missing", () => {
  assert.equal(isBotUserAgent(undefined), true);
});

// `bot` matches inside "CUBOT", a budget Android brand with real market
// share in Europe. Dropping those visitors is silent data loss, which is
// worse here than letting the occasional crawler through.
test("isBotUserAgent is false for a device whose model contains a bot pattern", () => {
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Linux; Android 13; CUBOT NOTE 21) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
    ),
    false,
  );
});

test("isBotUserAgent is false for real browser User-Agent strings", () => {
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    ),
    false,
  );
  assert.equal(
    isBotUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    ),
    false,
  );
});
