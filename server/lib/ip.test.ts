import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateIp, limiterKey } from "./ip.js";

test("truncateIp drops the last octet of an IPv4 address", () => {
  assert.equal(truncateIp("203.0.113.47"), "203.0.113.0");
  assert.equal(truncateIp("10.0.0.1"), "10.0.0.0");
  assert.equal(truncateIp("255.255.255.255"), "255.255.255.0");
  assert.equal(truncateIp("1.2.3.0"), "1.2.3.0");
});

// Dual-stack Node reports IPv4 peers this way, so missing this case
// would leave every IPv4 visitor untruncated on exactly the default
// deployment.
test("truncateIp handles IPv4-mapped IPv6 as IPv4", () => {
  assert.equal(truncateIp("::ffff:203.0.113.47"), "::ffff:203.0.113.0");
  assert.equal(truncateIp("::FFFF:10.0.0.9"), "::FFFF:10.0.0.0");
});

// /48, not /64: a household is normally given a whole /64, so keeping
// one would identify exactly what dropping the IPv4 octet prevents.
test("truncateIp keeps only the first three groups of an IPv6 address", () => {
  assert.equal(truncateIp("2001:db8:1:2:3:4:5:6"), "2001:db8:1::");
  assert.equal(truncateIp("2001:db8:1::5"), "2001:db8:1::");
  assert.equal(truncateIp("2001:db8:1:2::"), "2001:db8:1::");
  assert.equal(truncateIp("fe80::1"), "fe80:0:0::");
  assert.equal(truncateIp("::1"), "0:0:0::");
});

// The realistic bad input is not garbage, it is an ordinary address in
// the form a proxy writes. Left whole, the port made the hash unique
// per TCP connection — one visitor counted as dozens — and the address
// went into it whole, which is the one thing the privacy position
// rests on not happening.
test("truncateIp strips a port, brackets and a zone id before narrowing", () => {
  assert.equal(truncateIp("203.0.113.47:5678"), "203.0.113.0");
  assert.equal(truncateIp("203.0.113.47:5678"), truncateIp("203.0.113.47"));
  // Two connections from one visitor must not be two visitors.
  assert.equal(
    truncateIp("203.0.113.47:1111"),
    truncateIp("203.0.113.47:2222"),
  );
  assert.equal(truncateIp("[2001:db8:1:2::5]:443"), "2001:db8:1::");
  assert.equal(truncateIp("fe80::1%eth0"), "fe80:0:0::");
});

// Merging every unreadable address into one id under-counts, which
// shows. Handing back the raw value leaks the whole address into the
// hash, which does not.
test("truncateIp fails closed on an address it cannot read", () => {
  for (const value of [
    "not-an-ip",
    "203.0.113",
    "203.0.113.999",
    "203.0.113.1.5",
    "2001:db8::1::2",
    "2001:db8:1:2:3:4:5",
    "2001:zzzz:1::1",
  ]) {
    assert.equal(truncateIp(value), "unknown", `${value} should not be hashed`);
  }
  // An absent address stays distinguishable from an unreadable one.
  assert.equal(truncateIp(""), "");
});

// The narrowing is the whole privacy position, so it has to survive
// every spelling a real deployment can produce.
test("truncateIp never lets a full address through", () => {
  for (const value of [
    "203.0.113.47",
    "203.0.113.47:5678",
    "::ffff:203.0.113.47",
    "2001:db8:1:2:3:4:5:6",
    "[2001:db8:1:2::5]:443",
    "fe80::1%eth0",
    "not-an-ip",
  ]) {
    const out = truncateIp(value);
    assert.ok(
      out === "unknown" || out.endsWith(".0") || out.endsWith("::"),
      `${value} narrowed to ${out}, which still identifies a host`,
    );
  }
});

// --- limiterKey: what the abuse counters key on ---

// Scarce, and a /24 can hold hundreds of unrelated people behind one
// carrier NAT — so going wider would throttle them all for one abuser.
test("limiterKey keeps an IPv4 address whole", () => {
  assert.equal(limiterKey("203.0.113.47"), "203.0.113.47");
  assert.equal(limiterKey("203.0.113.48"), "203.0.113.48");
  assert.notEqual(limiterKey("203.0.113.47"), limiterKey("203.0.113.48"));
});

// Both spellings of one address have to be one key, or they are two
// budgets.
test("limiterKey treats an IPv4-mapped address as IPv4 and keeps it whole", () => {
  assert.equal(limiterKey("::ffff:203.0.113.47"), "203.0.113.47");
  assert.equal(limiterKey("::FFFF:203.0.113.47"), "203.0.113.47");
  assert.equal(
    limiterKey("::ffff:203.0.113.47"),
    limiterKey("203.0.113.47"),
    "mapped and plain must not be two budgets",
  );
});

// req.ip comes from a proxy header once TRUST_PROXY is set, and nothing
// guarantees the spelling written there.
test("limiterKey is the same for every spelling of one IPv6 block", () => {
  const key = limiterKey("2001:db8:1::5");
  assert.equal(limiterKey("2001:DB8:1::5"), key, "uppercase");
  assert.equal(limiterKey("2001:0db8:0001::5"), key, "leading zeros");
  assert.equal(limiterKey("2001:0DB8:1:0:0:0:0:5"), key, "both, expanded");
});

// The one that matters: a single line is delegated a whole block and
// can send from any address in it, so keying on the full address would
// let one attacker have as many budgets as they like — including as
// many runs at the cockpit password as they like.
test("limiterKey collapses an IPv6 block to one key", () => {
  const key = limiterKey("2001:db8:1:2::5");
  assert.equal(limiterKey("2001:db8:1:9::ffff"), key);
  assert.equal(limiterKey("2001:db8:1::1"), key);
  assert.equal(limiterKey("2001:db8:1:abcd:1:2:3:4"), key);
});

test("limiterKey keeps separate IPv6 blocks apart", () => {
  assert.notEqual(limiterKey("2001:db8:1:2::5"), limiterKey("2001:db8:2:2::5"));
  assert.notEqual(limiterKey("2001:db8:1:2::5"), limiterKey("2001:db9:1:2::5"));
});

// Fails *closed*. Keying an unreadable value on itself is how a
// limiter stops limiting: every distinct spelling would be a fresh
// budget, which is the hole this whole function exists to close.
test("limiterKey falls back to one shared key it cannot read an address", () => {
  assert.equal(limiterKey(""), "unknown");
  assert.equal(limiterKey("not-an-ip"), "unknown");
  assert.equal(limiterKey("2001:db8::1::2"), "unknown");
  assert.equal(limiterKey("1.2.3.999"), "unknown");
  // Two unreadable values are one bucket, not two.
  assert.equal(limiterKey("garbage-a"), limiterKey("garbage-b"));
});

// A proxy header is not a bare address. Azure App Service appends the
// source port, and so does any nginx writing $remote_addr:$remote_port
// — left alone, that is a fresh key per TCP connection and every
// counter here bounds nothing at all.
test("limiterKey ignores a port, brackets and a zone id", () => {
  assert.equal(limiterKey("1.2.3.4:5678"), limiterKey("1.2.3.4"));
  assert.equal(limiterKey("1.2.3.4:5678"), limiterKey("1.2.3.4:9999"));
  assert.equal(limiterKey("[2001:db8:1::5]:443"), limiterKey("2001:db8:1::5"));
  assert.equal(limiterKey("fe80::1%eth0"), limiterKey("fe80::1"));
  assert.equal(limiterKey("[fe80::1%eth0]:443"), limiterKey("fe80::1"));
});

// A dotted quad at the end is only an IPv4 address behind the v4-mapped
// or v4-compatible prefix. Reading "2001:db8::1.2.3.4" as "1.2.3.4"
// would drop the client into an unrelated one's bucket — ten failed
// logins from it would lock out whoever really holds 1.2.3.4.
test("limiterKey does not mistake an embedded quad for an IPv4 address", () => {
  assert.notEqual(limiterKey("2001:db8::1.2.3.4"), limiterKey("1.2.3.4"));
  assert.notEqual(
    limiterKey("2001:db8:1:2:3:4:1.2.3.4"),
    limiterKey("1.2.3.4"),
  );

  // It is narrowed as the IPv6 address it is, so the low bits cannot
  // buy a second budget either.
  assert.equal(
    limiterKey("2001:db8::1.2.3.4"),
    limiterKey("2001:db8::9.9.9.9"),
  );
  assert.equal(limiterKey("2001:db8:1:2:3:4:1.2.3.4"), "2001:db8:1::");
});

// The two prefixes that really do mean "this is an IPv4 address".
test("limiterKey reads a v4-mapped or v4-compatible address as IPv4", () => {
  assert.equal(limiterKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(limiterKey("::1.2.3.4"), "1.2.3.4");
});
