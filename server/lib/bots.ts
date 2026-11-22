// Catches crawlers and automation tools that name themselves in the
// User-Agent, which most do. A bot faking a real browser's User-Agent
// gets through here; the client script's `automated` mark
// (routes/events.ts) catches the common automation tools that do that.
// A missing User-Agent counts as a bot too, since real browsers always
// send one.
//
// Besides crawlers, three groups real visitors never match:
// - page-speed testers that run a real browser: Lighthouse (PageSpeed
//   Insights), GTmetrix, WebPageTest ("PTST"). Each run would otherwise
//   count as a visit.
// - headless browsers in general, not only HeadlessChrome.
// - HTTP libraries and command-line tools. They don't run the client
//   script, so a request from one was posted to /events directly.
const BOT_USER_AGENT_PATTERN =
  /bot|spider|crawl|slurp|facebookexternalhit|mediapartners|ia_archiver|headless|phantomjs|selenium|lighthouse|gtmetrix|ptst|curl|wget|python-|go-http-client|okhttp|axios|node-fetch|java\//i;

// Real devices whose model name contains one of the patterns above.
// CUBOT is an Android phone brand, and `bot` matches inside
// "CUBOT NOTE 21"; without this exception those visitors would be
// dropped as crawlers without anyone noticing.
//
// The pattern itself can't be tightened instead: /\bbot\b/ no longer
// matches "bingbot/2.0", and /bot\b/ still matches "CUBOT NOTE".
const NOT_A_BOT_PATTERN = /cubot/i;

export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (userAgent === undefined) return true;
  if (NOT_A_BOT_PATTERN.test(userAgent)) return false;
  return BOT_USER_AGENT_PATTERN.test(userAgent);
}
