export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

// Fails fast on a bad value rather than silently listening on NaN/an
// out-of-range port — same reasoning as retention.ts's parseRetentionDays.
export function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be an integer between 1 and 65535, got: ${value}`,
    );
  }
  return port;
}

// How many reverse proxies sit in front of this server. X-Forwarded-For
// is just text the sender writes, so trusting it without a proxy in
// front lets anyone forge a different req.ip per request — and req.ip is
// what every rate limiter counts, the cockpit's password lockout
// included. Defaults to 0 (believe nobody) so the exposed-port case is
// safe by default and proxying is the thing you opt into.
export function parseTrustProxy(value: string | undefined): number {
  // Explicitly, not by relying on Number("") being 0: a compose file
  // with a bare `TRUST_PROXY=` means unset, and the coincidence that
  // lands on the right answer is not worth depending on.
  if (value === undefined || value === "") return 0;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0 || hops > 10) {
    throw new Error(
      `TRUST_PROXY must be an integer between 0 and 10, got: ${value}`,
    );
  }
  return hops;
}

// A deployment whose credentials are public — the product page's demo
// instance, where anyone can read the MCP key off the page — needs
// every write closed, or the first visitor with an opinion erases the
// demo. Off unless set exactly to "true"; any other value throws, the
// same as LOCAL_BACKUPS, because a misspelt "ture" that quietly meant
// "no" would leave the delete tool live on a public key.
export function parseReadOnly(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`READ_ONLY must be "true" or "false", got: ${value}`);
}
