// Small shaping helpers used by more than one query module. Each of
// these was written out identically in two places before; they live
// here so a fix lands once, not so that lib/ grows a utility drawer —
// anything used by exactly one module stays in that module.

// What every ranked query returns. A bare top-N array told the agent
// nothing about what it was cut from: ten pages, or ten of four
// hundred? And a share of the total needed a second call whose unit
// might not even match. `groups` is how many distinct rows there were
// before the limit (so groups > items.length means the list was cut),
// and `total` is the ranked unit summed across all of them, so
// `row / total` is a share in the same unit with no second call.
export interface Ranked<T> {
  items: T[];
  groups: number;
  total: number;
}

// Sorts descending on `unit`, keeps `limit`, and reports what was cut.
// Every ranked query ends here — including the ones that used to
// `ORDER BY ... LIMIT` in SQL, which now hand over every group so the
// two figures can be read off the full set. The group counts involved
// (event types, languages, distinct prop values) are small at this
// project's scale; see "Target user" in docs/decisions.md.
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

// Both entry/exit breakdowns start from the same row set: one row per
// session, already carrying that session's first or last value (see the
// MIN/MAX bare-column trick in content.ts). All that differs is what
// the key is — a url's path in content.ts, an event type in events.ts —
// so counting, ranking and truncating happen here and the caller only
// renames the key to whatever its own result shape calls it.
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

// Renames the generic `key` of a session ranking to whatever the
// caller's result shape calls it, keeping groups and total intact.
export function mapRanked<T, U>(
  ranked: Ranked<T>,
  map: (item: T) => U,
): Ranked<U> {
  return { ...ranked, items: ranked.items.map(map) };
}

// Rounds a number being reported to a caller. Both call sites want a
// readable figure rather than a float's full tail, but at different
// precisions — money to 2 places, a rate to 4 — so the precision is a
// parameter rather than two near-identical one-line helpers.
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
