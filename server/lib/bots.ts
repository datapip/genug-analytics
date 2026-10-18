// Catches crawlers and automation tools that name themselves in the
// User-Agent, which most do. A bot pretending to be a real browser gets
// through; that is a known limit (see "Bot/spam filtering" in
// docs/decisions.md). A missing User-Agent counts as a bot too, since
// real browsers always send one.
const BOT_USER_AGENT_PATTERN =
  /bot|spider|crawl|slurp|facebookexternalhit|mediapartners|ia_archiver|headlesschrome|phantomjs|selenium/i;

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
