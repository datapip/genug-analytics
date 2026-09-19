// Best-effort only: catches crawlers/automation tools that identify
// themselves honestly (the vast majority — most well-behaved bots and
// headless-browser scrapers do), not a bot deliberately spoofing a real
// browser's User-Agent. That's an accepted gap, not a bug — see "Bot/spam
// filtering" in docs/decisions.md. A missing User-Agent header is treated as
// bot-like too, since a real browser always sends one.
const BOT_USER_AGENT_PATTERN =
  /bot|spider|crawl|slurp|facebookexternalhit|mediapartners|ia_archiver|headlesschrome|phantomjs|selenium/i;

// Real devices whose model name happens to contain one of the patterns
// above. CUBOT is a budget Android brand with real market share in
// Europe, and `bot` matches inside "CUBOT NOTE 21" — so without this
// exemption its owners are silently dropped as crawlers, which is the
// quiet, invisible data loss this project cares most about avoiding.
//
// Not fixable in the pattern itself: /\bbot\b/ stops matching
// "bingbot/2.0", and /bot\b/ still matches "CUBOT NOTE". An explicit
// exemption is the honest way to say "this one is a phone".
const NOT_A_BOT_PATTERN = /cubot/i;

export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (userAgent === undefined) return true;
  if (NOT_A_BOT_PATTERN.test(userAgent)) return false;
  return BOT_USER_AGENT_PATTERN.test(userAgent);
}
