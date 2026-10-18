export interface ClassifiedUserAgent {
  browser: string; // "Chrome" | "Safari" | "Firefox" | "Edge" | "Other"
  deviceType: "mobile" | "tablet" | "desktop" | "other";
}

// Deliberately simple regexes, not a full User-Agent parsing library.
// Runs once per request (routes/events.ts) and only the result is stored;
// the header itself never reaches the database, to collect as little as
// possible. So a fix here applies to new events only, not to stored ones.
// See "Device class instead of the User-Agent string" in
// docs/decisions.md.
export function classifyUserAgent(
  userAgent: string | null,
): ClassifiedUserAgent {
  const ua = userAgent ?? "";

  // Order matters: Edge and Chrome User-Agents both contain "Safari/",
  // and Edge's also contains "Chrome/", so check the most specific first.
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Other";

  // Anything unrecognised is "other", not "desktop": a smart TV, game
  // console or e-reader should show up as unknown rather than be counted
  // as a desktop visit.
  const deviceType = /Tablet|iPad/.test(ua)
    ? "tablet"
    : /Mobi/.test(ua)
      ? "mobile"
      : /Windows|Macintosh|X11/.test(ua) // X11 covers desktop Linux
        ? "desktop"
        : "other";

  return { browser, deviceType };
}
