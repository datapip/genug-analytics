// Shortening client IP addresses. Two kinds of callers need different
// widths, and the reasons are easiest to understand side by side:
//
// `truncateIp` is for the **visitor hash** (lib/identity.ts) and, through
// `blockIndex`, the **country lookup** (lib/country.ts).
// `limiterKey` is for the **abuse counters**: the /events and /mcp rate
// limits and the cockpit password lockout (lib/rateLimit.ts).

// 0-255, without a leading "+", spaces or leading zeros like "010".
const IPV4_OCTET = /^(0|[1-9][0-9]{0,2})$/;

function truncateIpv4(ip: string): string | undefined {
  const octets = ip.split(".");
  if (octets.length !== 4) return undefined;
  for (const octet of octets) {
    if (!IPV4_OCTET.test(octet) || Number(octet) > 255) return undefined;
  }
  return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
}

const IPV6_GROUP = /^[0-9a-f]{1,4}$/i;

// Returns the 8 groups of an IPv6 address with "::" expanded, or
// undefined if it is not one.
function expandIpv6(ip: string): string[] | undefined {
  const halves = ip.split("::");
  if (halves.length > 2) return undefined;

  const left = halves[0] ? halves[0].split(":") : [];
  const right =
    halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : undefined;

  if (right === undefined) {
    // Without "::", all 8 groups must be written out.
    if (left.length !== 8) return undefined;
    return left.every((group) => IPV6_GROUP.test(group)) ? left : undefined;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  return groups.every((group) => IPV6_GROUP.test(group)) ? groups : undefined;
}

// Node may report an IPv4 client as an IPv4-mapped IPv6 address
// (::ffff:203.0.113.5), so a dotted IPv4 part means IPv4, even with
// colons. That is enough for truncateIp. limiterKey needs the stricter
// embeddedIpv4 below.
function isIpv4(ip: string): boolean {
  return ip.includes(".");
}

// Shortens an address to its block: IPv4 to a /24, IPv6 to a /48. Used
// for the visitor hash and, through blockIndex, the country lookup;
// never for the abuse counters, which use limiterKey.
//
// Don't add limiterKey's normalising here (lowercasing, removing leading
// zeros, turning ::ffff:1.2.3.4 into 1.2.3.4). It looks like a harmless
// tidy-up, but the visitor id is a hash of exactly this output, so every
// consentless IPv6 visitor would quietly get a new id. Removing
// wrappers (stripWrappers) is shared on purpose: it only affects input
// this function couldn't read at all.
//
// Why shorten it, when the address is never stored? Anyone with the
// day's salt can recompute the hash. With the full address, they could
// check "was this exact person here today?"; with a shortened one only
// "was someone from this block here?". That difference matters when a
// site relies on legitimate interest instead of consent.
//
// The cost: two visitors with the same block and the same User-Agent
// count as one visitor (and one session if their visits overlap). So
// visitors and sessions are slightly under-counted.
export function truncateIp(ip: string): string {
  if (ip === "") return ip;

  // Remove the same wrappers as limiterKey. Proxies write addresses in
  // forms like "1.2.3.4:5678". Kept as they are, the full address would
  // go into the hash (contradicting the privacy notice), and the port,
  // which changes with every connection, would make one visitor count as
  // dozens. For an address that already parses, this changes nothing.
  const address = stripWrappers(ip);
  if (address === "") return UNKNOWN;

  if (isIpv4(address)) {
    const lastColon = address.lastIndexOf(":");
    const truncated = truncateIpv4(address.slice(lastColon + 1));
    // Like limiterKey, unreadable addresses all become "unknown".
    // Merging them under-counts visibly; returning the raw value would
    // quietly put the full address into the hash.
    if (truncated === undefined) return UNKNOWN;
    return address.slice(0, lastColon + 1) + truncated;
  }

  const groups = expandIpv6(address);
  if (groups === undefined) return UNKNOWN;
  return `${groups[0]}:${groups[1]}:${groups[2]}::`;
}

// The block of a truncateIp result as a number the country table
// (lib/country.ts) can search: the first three numbers of an IPv4
// address, or the /48 prefix of an IPv6 address. It takes truncateIp's
// output on purpose, so the country is looked up from the shortened
// address, never the full one. undefined for "unknown" or anything
// unreadable.
//
// An IPv4-mapped address counts as IPv4; "2001:db8::1.2.3.0" stays IPv6
// (see embeddedIpv4).
export function blockIndex(
  truncated: string,
): { family: 4 | 6; index: number } | undefined {
  const quad = embeddedIpv4(truncated);
  if (quad !== undefined) {
    const [a, b, c] = quad.split(".").map(Number) as [number, number, number];
    return { family: 4, index: (a * 256 + b) * 256 + c };
  }

  const groups = expandIpv6(hexifyEmbeddedQuad(truncated));
  if (groups === undefined) return undefined;
  const [g0, g1, g2] = groups.map((group) => parseInt(group, 16)) as [
    number,
    number,
    number,
  ];
  // 48 bits, small enough for a JavaScript number to hold exactly.
  return { family: 6, index: (g0 * 65536 + g1) * 65536 + g2 };
}

// The key every abuse counter uses. IPv4 and IPv6 are treated
// differently, because "one address is one client" is true for one and
// not the other.
//
// **IPv4 keeps the full address.** Addresses are scarce, so an attacker
// can't easily get more. Using a wider block would hurt others: a /24 can
// be a mobile carrier's range shared by hundreds of unrelated people.
//
// **IPv6 is shortened to a /48.** One home connection gets a whole block
// (a /56 or /48) and can send from any address in it. Keyed on the full
// address, the counters would limit nothing on IPv6, including the
// cockpit password lockout and the /mcp limit for requests without a key.
// A /48 is the largest block a connection usually gets, so no connection
// has more than one. The downside: where providers hand out /56 blocks,
// one /48 can hold a couple of hundred households sharing a limit. For
// the cockpit lockout that costs at most a fifteen-minute wait, and only
// for someone also typing wrong passwords. If /events ever refuses real
// IPv6 traffic, raise the limit rather than narrowing the block, which
// would open the gap again.
//
// The key must also be normalised. One address can be written several
// ways ("2001:DB8::1", "2001:0db8::1", "::ffff:1.2.3.4" vs "1.2.3.4"), and
// each spelling would get its own limit. Node writes a normal form for
// direct connections, but with TRUST_PROXY req.ip comes from a proxy
// header, which could contain anything.
export function limiterKey(ip: string): string {
  const address = stripWrappers(ip);
  if (address === "") return UNKNOWN;

  const quad = embeddedIpv4(address);
  if (quad !== undefined) return quad;

  const groups = expandIpv6(hexifyEmbeddedQuad(address));
  // Anything unreadable shares one key, "unknown". Using the raw value
  // as its own key would let the limit stop working: a proxy that adds
  // the port to X-Forwarded-For (Azure App Service does, as does nginx
  // with $remote_addr:$remote_port) would create a new key for every
  // connection. The usual forms are already handled above, and one
  // shared key also stops an attacker from filling the map with keys.
  // "unknown" in the "rate limit reached" log means a proxy is writing
  // something unexpected.
  if (groups === undefined) return UNKNOWN;
  return groups.slice(0, 3).map(canonicalGroup).join(":") + "::";
}

const UNKNOWN = "unknown";

// Removes what can surround an address in a proxy header: "[...]"
// brackets, a ":port" suffix, a "%eth0" zone.
function stripWrappers(ip: string): string {
  let address = ip.trim();

  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    if (close === -1) return "";
    address = address.slice(1, close);
  } else {
    // Only when it can't be misread: an IPv4 address followed by exactly
    // one colon. An IPv6 address has more colons, and "2001:db8::1" must
    // never be read as host "2001:db8:" with port 1.
    const colon = address.indexOf(":");
    const single = colon !== -1 && address.indexOf(":", colon + 1) === -1;
    if (single && address.includes(".")) address = address.slice(0, colon);
  }

  const zone = address.indexOf("%");
  return zone === -1 ? address : address.slice(0, zone);
}

// An IPv6 address may write its last 32 bits in IPv4 form
// ("2001:db8::1.2.3.4"). The expander only reads hex groups, so convert
// that part first, or the address would land under "unknown" instead of
// its own /48.
function hexifyEmbeddedQuad(ip: string): string {
  const lastColon = ip.lastIndexOf(":");
  if (lastColon === -1) return ip;

  const quad = ip.slice(lastColon + 1);
  if (truncateIpv4(quad) === undefined) return ip;

  const octets = quad.split(".").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const high = ((octets[0] << 8) | octets[1]).toString(16);
  const low = ((octets[2] << 8) | octets[3]).toString(16);
  return `${ip.slice(0, lastColon + 1)}${high}:${low}`;
}

// The IPv4 address hidden in an IPv6 one, or undefined.
//
// An IPv4 part at the end only means an IPv4 address after the prefixes
// ::ffff:0:0/96 (IPv4-mapped) or ::/96 (IPv4-compatible).
// "2001:db8::1.2.3.4" is a normal IPv6 address written that way. Reading
// it as "1.2.3.4" would share a counter with whoever really has 1.2.3.4,
// so ten wrong passwords from it would lock that person out.
function embeddedIpv4(ip: string): string | undefined {
  const lastColon = ip.lastIndexOf(":");
  const quad = ip.slice(lastColon + 1);
  if (truncateIpv4(quad) === undefined) return undefined;
  if (lastColon === -1) return quad;

  const groups = expandIpv6(`${ip.slice(0, lastColon + 1)}0:0`);
  if (groups === undefined) return undefined;

  const highZero = groups.slice(0, 5).every((g) => canonicalGroup(g) === "0");
  const marker = canonicalGroup(groups[5] ?? "");
  return highZero && (marker === "0" || marker === "ffff") ? quad : undefined;
}

// Lowercase without leading zeros, since "0DB8" and "db8" are the same
// group.
function canonicalGroup(group: string): string {
  return group.toLowerCase().replace(/^0+(?=.)/, "");
}
