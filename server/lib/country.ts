import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { blockIndex } from "./ip.js";

// Looks up the visitor's country from the shortened address (lib/ip.ts)
// in a table that ships with the image. No outside service is asked, and
// only the two-letter code is stored. Off unless COUNTRY_LOOKUP=true; see
// "Country" in docs/decisions.md.
//
// The table is ip-location-db's "user-country" (public domain, PDDL),
// downloaded when the image is built (scripts/fetch-country-data.mjs).
// It is as current as the image, which is good enough for countries.

// Stored when the lookup ran and found nothing: an unreadable address,
// or a range the table doesn't list. NULL means something else, that no
// lookup ran (the setting was off), so the two are never reported
// together as "unknown".
export const NO_COUNTRY = "ZZ";

export const COUNTRY_FILES = {
  4: "user-country-ipv4-num.csv",
  6: "user-country-ipv6-num.csv",
} as const;

// The agent reads these codes, so the file may contain only two capital
// letters per row; anything else rejects the whole table. That way no
// downloaded text can reach the agent.
const COUNTRY_CODE = /^[A-Z]{2}$/;

// The real file has hundreds of thousands of ranges. Far fewer means the
// download was cut short, and such a table would quietly answer ZZ for
// most visitors, so it is rejected.
const MIN_RANGES = 10_000;

// Far more means it is some other file. This is checked before reading,
// so an oversized file stops the startup with a clear reason instead of
// using up a small server's memory.
const MAX_FILE_BYTES = 100 * 1024 * 1024;

// The file lists full addresses, but a lookup only has a block (an IPv4
// /24, an IPv6 /48). Converting both to block numbers lets the search
// compare like with like.
const BLOCK_SHIFT = { 4: 8n, 6: 80n } as const;

interface Ranges {
  // Block numbers, sorted and not overlapping. codes[i] is the position
  // in `names` of the country for the range starts[i]..ends[i].
  starts: Float64Array;
  ends: Float64Array;
  codes: Uint16Array;
}

export interface CountryTable {
  // Takes truncateIp's output, never a full address.
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

      // Find the last range that starts at or before the block.
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

    // A block that spans several ranges gets the country of its first
    // range; later ranges in the same block are skipped.
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
