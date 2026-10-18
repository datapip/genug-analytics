// Small helpers that shape query results, shared by several query
// modules. A helper used by only one module belongs in that module.

// What every ranked query ("top 10 pages") returns. A plain list doesn't
// say whether it is ten pages out of ten or out of four hundred.
// `groups` is how many rows there were before the limit (more than
// items.length means the list was cut). `total` is the sum over all of
// them, so `row / total` is a row's share without a second query.
export interface Ranked<T> {
  items: T[];
  groups: number;
  total: number;
}

// Sorts by `unit`, highest first, keeps the first `limit` rows, and
// reports what was cut. Ranked queries return every group from SQL
// (no LIMIT) and cut here, so `groups` and `total` cover the full set.
// The number of groups (event types, languages, prop values) stays small
// for the sites this project is for; see "Target user" in
// docs/decisions.md.
export function rank<T>(
  rows: T[],
  unit: (row: T) => number,
  limit: number,
): Ranked<T> {
  const sorted = [...rows].sort((a, b) => unit(b) - unit(a));
  return {
    items: sorted.slice(0, limit),
    groups: rows.length,
    total: rows.reduce((sum, row) => sum + unit(row), 0),
  };
}

export interface SessionRank {
  key: string;
  sessions: number;
}

// Counts and ranks entry or exit values. The input is one row per
// session holding that session's first or last value (see the MIN/MAX
// note in content.ts). The value is a page in content.ts and an event
// type in events.ts; the caller renames `key` afterwards.
export function rankSessionsBy<T>(
  rows: T[],
  key: (row: T) => string,
  limit: number,
): Ranked<SessionRank> {
  const sessions = new Map<string, number>();
  for (const row of rows) {
    const rowKey = key(row);
    sessions.set(rowKey, (sessions.get(rowKey) ?? 0) + 1);
  }

  return rank(
    [...sessions.entries()].map(([key, sessions]) => ({ key, sessions })),
    (row) => row.sessions,
    limit,
  );
}

// Renames `key` in each ranked row to the caller's field name, keeping
// groups and total.
export function mapRanked<T, U>(
  ranked: Ranked<T>,
  map: (item: T) => U,
): Ranked<U> {
  return { ...ranked, items: ranked.items.map(map) };
}

// Rounds a reported number to `places` decimals, so the agent reads 0.25
// rather than 0.25000000000000006 (money uses 2, rates use 4).
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
