import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, rankSessionsBy, roundTo } from "./aggregate.js";

test("rankSessionsBy counts one session per row and ranks descending", () => {
  const rows = [
    { path: "/pricing" },
    { path: "/" },
    { path: "/pricing" },
    { path: "/" },
    { path: "/" },
  ];

  assert.deepEqual(
    rankSessionsBy(rows, (row) => row.path, 10),
    {
      items: [
        { key: "/", sessions: 3 },
        { key: "/pricing", sessions: 2 },
      ],
      groups: 2,
      total: 5,
    },
  );
});

test("rankSessionsBy truncates to the limit, keeping the largest", () => {
  const rows = [
    { event: "a" },
    { event: "b" },
    { event: "b" },
    { event: "c" },
    { event: "c" },
    { event: "c" },
  ];

  assert.deepEqual(
    rankSessionsBy(rows, (row) => row.event, 2),
    {
      items: [
        { key: "c", sessions: 3 },
        { key: "b", sessions: 2 },
      ],
      groups: 3,
      total: 6,
    },
  );
});

test("rankSessionsBy returns nothing for no rows", () => {
  assert.deepEqual(
    rankSessionsBy([] as { path: string }[], (row) => row.path, 10),
    { items: [], groups: 0, total: 0 },
  );
});

// The key function is what makes this shared: content.ts derives a url
// path, events.ts reads an event name. Rows that differ but key the
// same have to merge, or top pages would fragment by query string.
test("rankSessionsBy merges rows whose derived key matches", () => {
  const rows = [
    { url: "https://example.com/a?utm=x" },
    { url: "https://example.com/a?utm=y" },
  ];

  assert.deepEqual(
    rankSessionsBy(rows, (row) => new URL(row.url).pathname, 10),
    { items: [{ key: "/a", sessions: 2 }], groups: 1, total: 2 },
  );
});

test("roundTo rounds to the requested number of decimals", () => {
  assert.equal(roundTo(1 / 3, 4), 0.3333);
  assert.equal(roundTo(2 / 3, 4), 0.6667);
  assert.equal(roundTo(49.899999999, 2), 49.9);
  assert.equal(roundTo(10, 2), 10);
});

// A rate of exactly 0 or 1 must stay exactly that — a bounce rate
// rendered as 0.9999999 would read as "not quite everyone".
test("roundTo leaves whole values exact", () => {
  assert.equal(roundTo(0, 4), 0);
  assert.equal(roundTo(1, 4), 1);
});

test("rank keeps the largest, and reports groups and total from before the cut", () => {
  const rows = [
    { key: "b", n: 2 },
    { key: "a", n: 5 },
    { key: "c", n: 1 },
  ];
  assert.deepEqual(
    rank(rows, (row) => row.n, 2),
    { items: [rows[1], rows[0]], groups: 3, total: 8 },
  );
});

test("rank of nothing is an empty, zeroed wrapper", () => {
  assert.deepEqual(
    rank([], () => 0, 10),
    { items: [], groups: 0, total: 0 },
  );
});
