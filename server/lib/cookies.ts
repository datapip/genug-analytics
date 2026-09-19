// Reading a Cookie header, which two unrelated parts of this server now
// need: /events for the consentful visitor id, and /cockpit for its
// session. Lifted here from routes/events.ts unchanged rather than
// imported across — a lib module reaching into a route module is
// backwards, and copying twenty lines would leave two of them to drift.
export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding — treat as if this cookie weren't sent.
    }
  }
  return cookies;
}
