export interface ClassifiedUserAgent {
  browser: string; // "Chrome" | "Safari" | "Firefox" | "Edge" | "Other"
  deviceType: "mobile" | "tablet" | "desktop" | "other";
}

// Deliberately simple, regex-based — not a full UA-parsing library.
// Runs once per request, at write time (routes/events.ts), and only the
// result is stored: the header itself never reaches the database, so a
// fix here applies from then on rather than to history. That was the
// other way round once — the raw string was kept so the classifier
// could be corrected retroactively — and was reversed for data
// minimisation; see "Device class instead of the User-Agent string" in
// docs/decisions.md.
export function classifyUserAgent(
  userAgent: string | null,
): ClassifiedUserAgent {
  const ua = userAgent ?? "";

  // Order matters: Edge and Chrome UAs both contain "Safari/", and
  // Edge's also contains "Chrome/" — most-specific match first, same
  // reasoning as isBotUserAgent's regex ordering.
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";

  // "other" (not a silent fallthrough to "desktop") for anything that
  // doesn't match a known signature — a smart TV, game console, or
  // e-reader UA should read as unclassified, not get miscounted as a
  // desktop visit. Same "a mistake should look like a mistake" reasoning
  // as get_top_referrers' explicit null-for-direct-traffic bucket.
  const deviceType = /Tablet|iPad/.test(ua)
    ? "tablet"
    : /Mobi/.test(ua)
      ? "mobile"
      : /Windows|Macintosh|X11/.test(ua) // X11 covers desktop Linux
        ? "desktop"
        : "other";

  return { browser, deviceType };
}
