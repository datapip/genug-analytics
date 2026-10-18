import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateIp, limiterKey, blockIndex } from "./ip.js";

test("truncateIp drops the last octet of an IPv4 address", () => {
  assert.equal(truncateIp("203.0.113.47"), "203.0.113.0");
  assert.equal(truncateIp("10.0.0.1"), "10.0.0.0");
  assert.equal(truncateIp("255.255.255.255"), "255.255.255.0");
  assert.equal(truncateIp("1.2.3.0"), "1.2.3.0");
});

// Node often reports IPv4 clients this way, so this case is common.
test("truncateIp handles IPv4-mapped IPv6 as IPv4", () => {
  assert.equal(truncateIp("::ffff:203.0.113.47"), "::ffff:203.0.113.0");
  assert.equal(truncateIp("::FFFF:10.0.0.9"), "::FFFF:10.0.0.0");
});

// /48, not /64: a household usually has a whole /64, so a /64 would
// identify the household.
test("truncateIp keeps only the first three groups of an IPv6 address", () => {
  assert.equal(truncateIp("2001:db8:1:2:3:4:5:6"), "2001:db8:1::");
  assert.equal(truncateIp("2001:db8:1::5"), "2001:db8:1::");
  assert.equal(truncateIp("2001:db8:1:2::"), "2001:db8:1::");
  assert.equal(truncateIp("fe80::1"), "fe80:0:0::");
  assert.equal(truncateIp("::1"), "0:0:0::");
});

// Addresses in the forms proxies write (with a port or brackets) must
// be shortened too. Otherwise the full address would go into the hash,
// and the port would make one visitor count as dozens.
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

// Unreadable addresses all become "unknown". Returning the raw value
// would quietly put the full address into the hash.
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

// Shortening must work for every way an address can be written.
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

// IPv4 keeps the full address: a /24 can be hundreds of unrelated
// people on a mobile network, who shouldn't share a limit.
test("limiterKey keeps an IPv4 address whole", () => {
  assert.equal(limiterKey("203.0.113.47"), "203.0.113.47");
  assert.equal(limiterKey("203.0.113.48"), "203.0.113.48");
  assert.notEqual(limiterKey("203.0.113.47"), limiterKey("203.0.113.48"));
});

// Two spellings of one address must give one key, or they would get
// two limits.
test("limiterKey treats an IPv4-mapped address as IPv4 and keeps it whole", () => {
  assert.equal(limiterKey("::ffff:203.0.113.47"), "203.0.113.47");
  assert.equal(limiterKey("::FFFF:203.0.113.47"), "203.0.113.47");
  assert.equal(
    limiterKey("::ffff:203.0.113.47"),
    limiterKey("203.0.113.47"),
    "mapped and plain must not be two budgets",
  );
});

// With TRUST_PROXY, req.ip comes from a proxy header, which may be
// written in any form.
test("limiterKey is the same for every spelling of one IPv6 block", () => {
  const key = limiterKey("2001:db8:1::5");
  assert.equal(limiterKey("2001:DB8:1::5"), key, "uppercase");
  assert.equal(limiterKey("2001:0db8:0001::5"), key, "leading zeros");
  assert.equal(limiterKey("2001:0DB8:1:0:0:0:0:5"), key, "both, expanded");
});

// One connection gets a whole IPv6 block and can use any address in it,
// so keying on the full address would give an attacker unlimited tries,
// including at the cockpit password.
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

// Unreadable values share one key. Using each value as its own key
// would give every spelling its own limit.
test("limiterKey falls back to one shared key it cannot read an address", () => {
  assert.equal(limiterKey(""), "unknown");
  assert.equal(limiterKey("not-an-ip"), "unknown");
  assert.equal(limiterKey("2001:db8::1::2"), "unknown");
  assert.equal(limiterKey("1.2.3.999"), "unknown");
  // Two unreadable values are one bucket, not two.
  assert.equal(limiterKey("garbage-a"), limiterKey("garbage-b"));
});

// Proxy headers may add the port (Azure App Service does, as does nginx
// with $remote_addr:$remote_port). Kept, every connection would get its
// own key and the limits would do nothing.
test("limiterKey ignores a port, brackets and a zone id", () => {
  assert.equal(limiterKey("1.2.3.4:5678"), limiterKey("1.2.3.4"));
  assert.equal(limiterKey("1.2.3.4:5678"), limiterKey("1.2.3.4:9999"));
  assert.equal(limiterKey("[2001:db8:1::5]:443"), limiterKey("2001:db8:1::5"));
  assert.equal(limiterKey("fe80::1%eth0"), limiterKey("fe80::1"));
  assert.equal(limiterKey("[fe80::1%eth0]:443"), limiterKey("fe80::1"));
});

// An IPv4 part at the end only means IPv4 after the IPv4-mapped or
// IPv4-compatible prefix. Reading "2001:db8::1.2.3.4" as "1.2.3.4" would
// share a limit with whoever really has 1.2.3.4.
test("limiterKey does not mistake an embedded quad for an IPv4 address", () => {
  assert.notEqual(limiterKey("2001:db8::1.2.3.4"), limiterKey("1.2.3.4"));
  assert.notEqual(
    limiterKey("2001:db8:1:2:3:4:1.2.3.4"),
    limiterKey("1.2.3.4"),
  );

  // It is shortened as an IPv6 address, so changing the last part
  // doesn't give a new limit.
  assert.equal(
    limiterKey("2001:db8::1.2.3.4"),
    limiterKey("2001:db8::9.9.9.9"),
  );
  assert.equal(limiterKey("2001:db8:1:2:3:4:1.2.3.4"), "2001:db8:1::");
});

// The two prefixes that do mean "this is an IPv4 address".
test("limiterKey reads a v4-mapped or v4-compatible address as IPv4", () => {
  assert.equal(limiterKey("::ffff:1.2.3.4"), "1.2.3.4");
  assert.equal(limiterKey("::1.2.3.4"), "1.2.3.4");
});

// The country table is searched by block, so the index must be the
// block of truncateIp's output, however the address was written.
test("blockIndex numbers the /24 or /48 of a truncated address", () => {
  assert.deepEqual(blockIndex(truncateIp("1.2.3.4")), {
    family: 4,
    index: (1 * 256 + 2) * 256 + 3,
  });
  assert.deepEqual(blockIndex(truncateIp("::ffff:1.2.3.4")), {
    family: 4,
    index: (1 * 256 + 2) * 256 + 3,
  });
  assert.deepEqual(blockIndex(truncateIp("2001:db8:5:6::1")), {
    family: 6,
    index: (0x2001 * 65536 + 0xdb8) * 65536 + 5,
  });
  // Not IPv4-mapped: an IPv6 address with its last part written as IPv4
  // (see embeddedIpv4).
  assert.equal(blockIndex(truncateIp("2001:db8::1.2.3.4"))?.family, 6);
  assert.equal(blockIndex(truncateIp("garbage")), undefined);
  assert.equal(blockIndex(""), undefined);
});
