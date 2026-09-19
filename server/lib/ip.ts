// Everything to do with narrowing a client address, in one place
// because two different callers need two different widths and the
// reasoning for each only makes sense beside the other.
//
// `truncateIp` narrows for the **visitor hash** (lib/identity.ts).
// `limiterKey` narrows for the **counters** that bound abuse: the
// /events and /mcp request limits, the /mcp key lockout and the
// cockpit password lockout (lib/rateLimit.ts).

// 0-255, no leading "+", no whitespace, no "010" octal-looking parts.
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
    // No "::", so every group has to be written out.
    if (left.length !== 8) return undefined;
    return left.every((group) => IPV6_GROUP.test(group)) ? left : undefined;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  return groups.every((group) => IPV6_GROUP.test(group)) ? groups : undefined;
}

// Dual-stack Node reports IPv4 peers as IPv4-mapped IPv6
// (::ffff:203.0.113.5), so the dotted quad decides the family, not the
// colons. Good enough for truncateIp, which rebuilds the address around
// the quad and so cannot mistake one for another; limiterKey replaces
// the quad with itself and needs the stricter embeddedIpv4 below.
function isIpv4(ip: string): boolean {
  return ip.includes(".");
}

// Narrows an address to its block: IPv4 to a /24, IPv6 to a /48.
// Used *only* for the visitor hash.
//
// Never move limiterKey's *canonicalisation* into this function —
// lowercasing, leading-zero stripping, rewriting a v4-mapped address
// as a bare quad. It is the obvious-looking tidy-up and it would
// silently give every consentless IPv6 visitor a new id, because the
// id is a hash of exactly this output. Stripping wrappers is a
// different matter and is shared deliberately: it only touches input
// that this function could not read at all.
//
// Why narrow it at all, when the raw address is never stored: the hash
// is reproducible by anyone holding SALT_SECRET, so a full address
// makes "was this exact person here today" answerable. A truncated one
// only answers "was someone from this block here", which is the
// difference a supervisory authority looks for when an operator relies
// on legitimate interest instead of consent.
//
// The cost is real and one-directional: two visitors sharing a block
// *and* a User-Agent string become one visitor, and one session if
// they overlap within the session timeout. Visitors and sessions come
// out under-counted, events-per-session over-counted.
export function truncateIp(ip: string): string {
  if (ip === "") return ip;

  // Same wrappers limiterKey strips, for a worse reason. This used to
  // hand back anything it could not parse, unchanged — and the values
  // it cannot parse are not garbage, they are ordinary addresses in the
  // forms a proxy writes. "1.2.3.4:5678" was hashed whole, so the
  // deployment's own privacy notice became untrue (the full address
  // went into the hash) and the port made it worse than untruncated:
  // unique per TCP connection, so one visitor counted as dozens.
  // Stripping changes nothing for an address that already parsed.
  const address = stripWrappers(ip);
  if (address === "") return UNKNOWN;

  if (isIpv4(address)) {
    const lastColon = address.lastIndexOf(":");
    const truncated = truncateIpv4(address.slice(lastColon + 1));
    // Fails closed, like limiterKey. Merging every unreadable address
    // into one id under-counts visibly; handing back the raw value
    // leaks the whole address into the hash invisibly, and the hash is
    // the one thing the privacy position rests on.
    if (truncated === undefined) return UNKNOWN;
    return address.slice(0, lastColon + 1) + truncated;
  }

  const groups = expandIpv6(address);
  if (groups === undefined) return UNKNOWN;
  return `${groups[0]}:${groups[1]}:${groups[2]}::`;
}

// What every abuse counter keys on. The two families are treated
// differently on purpose, because "one address is one client" is true
// of one of them and not the other.
//
// **IPv4 keeps the full address.** Addresses are scarce and an
// attacker cannot cheaply get more, while the collateral of going
// wider is severe: a /24 can be a mobile carrier's pool or a CGNAT
// range holding hundreds of unrelated people, and throttling all of
// them for one abuser is the failure the /events ceiling is
// deliberately generous to avoid.
//
// **IPv6 is narrowed to a /48.** The same reasoning inverts: a single
// residential line is *delegated* a /56 or a /48 and can freely send
// from any address inside it, so keying on the full address means the
// counters bound nothing at all for anyone on IPv6. That mattered most
// where it was least visible — the cockpit password lockout and the
// /mcp key lockout are the only thing standing between a guesser and a
// single shared secret at an entirely predictable hostname, and both
// were bypassable by rotating within a block the attacker already
// holds. A /48 is the largest common end-site delegation, so no line
// spans more than one, which is the property the counter needs. It is
// deliberately the over-grouping error rather than the under-grouping
// one: plenty of providers, German residential among them, delegate a
// /56, so one /48 can hold a couple of hundred unrelated households,
// and they share a budget. For the lockouts that is near-free — the
// collateral is a fifteen-minute wait, and only for someone who is
// themselves failing auth. For /events it is the real cost, and the
// knob to reach for if a deployment ever sees refusals against an IPv6
// key is the ceiling, not the width: narrowing less would hand the
// bypass straight back.
// A counter's key has to be *canonical*, not merely narrowed. One
// address has several legal spellings — "2001:DB8::1" and "2001:db8::1",
// "2001:0db8::1" and "2001:db8::1", "::ffff:1.2.3.4" and "1.2.3.4" —
// and each spelling that reaches the map unchanged is another budget
// for the same client. Node writes the canonical form for a direct
// connection, so this is defence in depth rather than a live hole, but
// req.ip comes from a proxy header once TRUST_PROXY is set and nothing
// guarantees what is written there.
export function limiterKey(ip: string): string {
  const address = stripWrappers(ip);
  if (address === "") return UNKNOWN;

  const quad = embeddedIpv4(address);
  if (quad !== undefined) return quad;

  const groups = expandIpv6(hexifyEmbeddedQuad(address));
  // Fails closed. Keying an unreadable value on itself is how a
  // limiter quietly stops limiting: a proxy that appends the source
  // port to X-Forwarded-For (Azure App Service does, so does any nginx
  // writing $remote_addr:$remote_port) would give every counter here a
  // fresh key per TCP connection. The wrappers stripped above are the
  // forms that actually occur; anything still unreadable is rare
  // enough that one shared bucket is the safe way to be wrong, and it
  // also stops an attacker growing this map with keys of their own
  // choosing. It shows up in the "rate limit reached" log as
  // "unknown", which is the signal that a proxy is writing something
  // unexpected.
  if (groups === undefined) return UNKNOWN;
  return groups.slice(0, 3).map(canonicalGroup).join(":") + "::";
}

const UNKNOWN = "unknown";

// Peels off what sits *around* an address: a "[...]" wrapper, a
// ":port" suffix, a "%eth0" zone. Each is a legal thing to find in a
// proxy header and none of them belongs in the key.
function stripWrappers(ip: string): string {
  let address = ip.trim();

  if (address.startsWith("[")) {
    const close = address.indexOf("]");
    if (close === -1) return "";
    address = address.slice(1, close);
  } else {
    // Only where it cannot be ambiguous: a dotted quad with exactly one
    // colon after it. A bare IPv6 address has more, and "2001:db8::1"
    // must never be read as host 2001:db8: port 1.
    const colon = address.indexOf(":");
    const single = colon !== -1 && address.indexOf(":", colon + 1) === -1;
    if (single && address.includes(".")) address = address.slice(0, colon);
  }

  const zone = address.indexOf("%");
  return zone === -1 ? address : address.slice(0, zone);
}

// An IPv6 address is allowed to write its low 32 bits as a dotted quad
// even when the prefix is nothing special ("2001:db8::1.2.3.4"). The
// expander only knows hex groups, so that spelling would otherwise be
// unreadable and land in the shared bucket instead of its own /48.
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

// The IPv4 address this really is, or undefined.
//
// A dotted quad at the end is only an IPv4 address when what precedes
// it is the v4-mapped (::ffff:0:0/96) or v4-compatible (::/96) prefix.
// "2001:db8::1.2.3.4" is an ordinary IPv6 address whose low 32 bits are
// merely written that way, and reading it as "1.2.3.4" would drop the
// /48 narrowing *and* drop the client into an unrelated one's bucket —
// so ten failed logins from it would lock out whoever really holds
// 1.2.3.4.
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

// Lowercase, no leading zeros: "0DB8" and "db8" are the same group.
function canonicalGroup(group: string): string {
  return group.toLowerCase().replace(/^0+(?=.)/, "");
}
