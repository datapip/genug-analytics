// Parses a Cookie header into name → value. Used by /events (the
// visitor id cookie) and by /cockpit (the sign-in session).
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
