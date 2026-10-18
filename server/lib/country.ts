import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blockIndex } from "./ip.js";

// The visitor's country, looked up on this server from the shortened
// address (lib/ip.ts) in a table shipped with the image. Nothing is
// asked of any outside service and only the two-letter code is stored.
// Off unless COUNTRY_LOOKUP=true: see "Country" in docs/decisions.md.
//
// The table is ip-location-db's "user-country" (public domain, PDDL),
// fetched at image build by scripts/fetch-country-data.mjs. It is as
// fresh as the image, which is fine at country level.

// Stored when the lookup ran and found nothing: an unreadable address,
// or a block the table does not list. Distinct from NULL, which means
// no lookup ran — a row from before COUNTRY_LOOKUP was on, or with it
// off — so the two are never reported as one "unknown".
export const NO_COUNTRY = "ZZ";

export const COUNTRY_FILES = {
  4: "user-country-ipv4-num.csv",
  6: "user-country-ipv6-num.csv",
} as const;

// The codes are what the agent reads back, so the file may only hold
// this shape; anything else refuses the whole table. That keeps the
// column a closed list rather than text from a download.
const COUNTRY_CODE = /^[A-Z]{2}$/;

// The real files hold hundreds of thousands of ranges. Far fewer means
// a truncated download, and a table that quietly answers ZZ for most
// visitors is the plausible-while-wrong failure, so it refuses instead.
const MIN_RANGES = 10_000;

// And far more means something that is not this table at all. Checked
// before reading, so an oversized download stops the start with a
// reason instead of running a small server out of memory.
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// The file's numbers are whole addresses; a lookup has only a block
// (an IPv4 /24, an IPv6 /48). Shifting both ends down to block indexes
// makes the search exact on what is actually known.
const BLOCK_SHIFT = { 4: 8n, 6: 80n } as const;

interface Ranges {
  // Block indexes, sorted and non-overlapping; codes[i] is the
  // index into `names` for the range starts[i]..ends[i].
  starts: Float64Array;
  ends: Float64Array;
  codes: Uint16Array;
}

export interface CountryTable {
  // Takes truncateIp's output, never an address.
  lookup(truncated: string): string;
}

export function loadCountryTable(
  dir: string,
  minRanges = MIN_RANGES,
): CountryTable {
  const names: string[] = [];
  const tables = {
    4: loadRanges(join(dir, COUNTRY_FILES[4]), 4, names, minRanges),
    6: loadRanges(join(dir, COUNTRY_FILES[6]), 6, names, minRanges),
  };

  return {
    lookup(truncated) {
      const block = blockIndex(truncated);
      if (block === undefined) return NO_COUNTRY;
      const { starts, ends, codes } = tables[block.family];

      // The last range starting at or before the block.
      let low = 0;
      let high = starts.length - 1;
      let found = -1;
      while (low <= high) {
        const mid = (low + high) >>> 1;
        if (starts[mid]! <= block.index) {
          found = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return found !== -1 && block.index <= ends[found]!
        ? names[codes[found]!]!
        : NO_COUNTRY;
    },
  };
}

function loadRanges(
  path: string,
  family: 4 | 6,
  names: string[],
  minRanges: number,
): Ranges {
  let text: string;
  try {
    const size = statSync(path).size;
    if (size > MAX_FILE_BYTES) {
      throw new Error(`it is ${size} bytes, more than a country table holds`);
    }
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `COUNTRY_LOOKUP is on, but the country table ${path} could not be read ` +
        `(${(error as Error).message}). The Docker image ships it; outside ` +
        `Docker, run: node scripts/fetch-country-data.mjs`,
      { cause: error },
    );
  }

  const lines = text.split("\n").filter((line) => line !== "");
  const starts = new Float64Array(lines.length);
  const ends = new Float64Array(lines.length);
  const codes = new Uint16Array(lines.length);
  const shift = BLOCK_SHIFT[family];
  const nameIndex = new Map(names.map((name, index) => [name, index]));
  let count = 0;
  let previousEnd = -1;

  for (const [index, line] of lines.entries()) {
    const fail = (why: string) =>
      new Error(`Country table ${path}, line ${index + 1}: ${why}`);
    const [startText, endText, code, extra] = line.trim().split(",");
    if (
      extra !== undefined ||
      !/^\d+$/.test(startText ?? "") ||
      !/^\d+$/.test(endText ?? "")
    ) {
      throw fail("expected start,end,country");
    }
    if (!COUNTRY_CODE.test(code ?? "")) {
      throw fail(`"${code}" is not a two-letter country code`);
    }

    const first = BigInt(startText!);
    const last = BigInt(endText!);
    if (last < first) throw fail("the range ends before it starts");
    let start = Number(first >> shift);
    const end = Number(last >> shift);
    if (start < previousEnd) throw fail("the ranges are not in order");

    // A block split between several ranges takes the country of its
    // lowest part; the rest of that block is already claimed.
    if (start === previousEnd) start += 1;
    if (start > end) continue;

    let name = nameIndex.get(code!);
    if (name === undefined) {
      name = names.push(code!) - 1;
      nameIndex.set(code!, name);
    }
    starts[count] = start;
    ends[count] = end;
    codes[count] = name;
    count++;
    previousEnd = end;
  }

  if (count < minRanges) {
    throw new Error(
      `Country table ${path} holds ${count} ranges, fewer than the ` +
        `${minRanges} a complete one has. Fetch it again: ` +
        `node scripts/fetch-country-data.mjs`,
    );
  }

  return {
    starts: starts.slice(0, count),
    ends: ends.slice(0, count),
    codes: codes.slice(0, count),
  };
}
