import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COUNTRY_FILES, NO_COUNTRY, loadCountryTable } from "./country.js";
import { truncateIp } from "./ip.js";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function v4(address: string): bigint {
  return address
    .split(".")
    .reduce((sum, octet) => sum * 256n + BigInt(octet), 0n);
}

// The 48-bit prefix "a:b:c" as the first address of its /48.
function v6(prefix: string): bigint {
  const [a, b, c] = prefix.split(":").map((group) => BigInt(`0x${group}`));
  return ((a! << 32n) | (b! << 16n) | c!) << 80n;
}

function table(ipv4: string[], ipv6: string[], minRanges = 1) {
  const dir = mkdtempSync(join(tmpdir(), "genug-country-"));
  dirs.push(dir);
  writeFileSync(join(dir, COUNTRY_FILES[4]), ipv4.join("\n") + "\n");
  writeFileSync(join(dir, COUNTRY_FILES[6]), ipv6.join("\n") + "\n");
  return () => loadCountryTable(dir, minRanges);
}

const FIXTURE = table(
  [
    `${v4("1.2.3.0")},${v4("1.2.3.255")},DE`,
    // One /24 split between two countries, the second running on into
    // the next blocks.
    `${v4("5.6.7.0")},${v4("5.6.7.127")},AT`,
    `${v4("5.6.7.128")},${v4("5.6.9.255")},CH`,
    `${v4("8.0.0.0")},${v4("8.255.255.255")},US`,
  ],
  [
    `${v6("2001:db8:0")},${v6("2001:db9:0") - 1n},NL`,
    // The same at /48, in /64s.
    `${v6("2a00:1:0")},${v6("2a00:1:0") + (1n << 64n) - 1n},FR`,
    `${v6("2a00:1:0") + (1n << 64n)},${v6("2a00:1:3") - 1n},BE`,
  ],
);

test("looks up the country of a shortened address", () => {
  const countries = FIXTURE();
  assert.equal(countries.lookup(truncateIp("1.2.3.4")), "DE");
  assert.equal(countries.lookup(truncateIp("8.8.8.8")), "US");
  assert.equal(countries.lookup(truncateIp("2001:db8:5::1")), "NL");
});

// Node often reports IPv4 clients this way, so this is common on a real
// server.
test("a v4-mapped address is looked up as IPv4", () => {
  assert.equal(FIXTURE().lookup(truncateIp("::ffff:1.2.3.4")), "DE");
});

// Only the block is known, so a block split between two countries gets
// the first one. The other range still owns the blocks after it; many
// real ranges start in the middle of a block.
test("a block split between countries takes its lowest part's, and the rest keeps what follows", () => {
  const countries = FIXTURE();
  assert.equal(countries.lookup(truncateIp("5.6.7.200")), "AT");
  assert.equal(countries.lookup(truncateIp("5.6.8.1")), "CH");
  assert.equal(countries.lookup(truncateIp("5.6.9.1")), "CH");
  assert.equal(countries.lookup(truncateIp("2a00:1:0:1::5")), "FR");
  assert.equal(countries.lookup(truncateIp("2a00:1:1::1")), "BE");
  assert.equal(countries.lookup(truncateIp("2a00:1:2::1")), "BE");
  assert.equal(countries.lookup(truncateIp("2a00:1:3::1")), NO_COUNTRY);
});

test("an address the table does not list, or cannot be read, is ZZ", () => {
  const countries = FIXTURE();
  assert.equal(countries.lookup(truncateIp("9.9.9.9")), NO_COUNTRY);
  assert.equal(countries.lookup(truncateIp("2001:dead::1")), NO_COUNTRY);
  assert.equal(countries.lookup(truncateIp("not an address")), NO_COUNTRY);
  assert.equal(countries.lookup(truncateIp("")), NO_COUNTRY);
});

// The agent sees the stored codes, so the file may only contain country
// codes, and a damaged file is rejected, not partly loaded.
test("a file that is not a country table is refused, naming the line", () => {
  const cases: [string[], RegExp][] = [
    [[`${v4("1.2.3.0")},${v4("1.2.3.255")},de`], /line 1: "de" is not/],
    [[`${v4("1.2.3.0")},${v4("1.2.3.255")},<b>`], /line 1: "<b>" is not/],
    [[`1.2.3.0,1.2.3.255,DE`], /line 1: expected start,end,country/],
    [
      [
        `${v4("8.0.0.0")},${v4("8.0.0.255")},US`,
        `${v4("1.2.3.0")},${v4("1.2.3.255")},DE`,
      ],
      /line 2: the ranges are not in order/,
    ],
  ];
  for (const [ipv4, expected] of cases) {
    assert.throws(
      table(ipv4, [`${v6("2001:db8:0")},${v6("2001:db8:1")},NL`]),
      expected,
    );
  }
});

test("a table far smaller than a complete one is refused", () => {
  assert.throws(
    table(
      [`${v4("1.2.3.0")},${v4("1.2.3.255")},DE`],
      [`${v6("2001:db8:0")},${v6("2001:db8:1")},NL`],
      10_000,
    ),
    /holds 1 ranges, fewer than the 10000/,
  );
});

test("a missing table says how to get one", () => {
  assert.throws(
    () => loadCountryTable(join(tmpdir(), "genug-no-such-dir")),
    /COUNTRY_LOOKUP is on.*fetch-country-data/s,
  );
});
