// Which sessions a period "owns", for the queries that look at a
// session's shape — where it entered, where it left, whether it
// bounced, how long it lasted — rather than at how much happened.
//
// Those queries used to take every event with a timestamp inside the
// period and group by session, so a session already under way at
// `from` had its first in-window event reported as its entry, and a
// session with three page views before `from` and one after was
// reported as a bounce. The error grows as the period shrinks: on a
// one-hour window most sessions straddle an edge.
//
// A session belongs to the period its first event falls in, and is
// then read in full — including anything after `to`, which is where a
// session that started late in the period genuinely exited. Volume
// queries (the traffic summary, the per-day trend) deliberately keep
// counting sessions *active* in the period instead, because "how many
// sessions touched Tuesday" is what those answer; their descriptions
// say so.
//
// Candidates come from the ts index, and MIN(ts) per candidate is an
// index lookup on (session_id, ts), so this never scans sessions that
// had no event in the window. Bound to @from and @to like every other
// period query.
const SESSIONS_STARTED_IN_PERIOD = `
  SELECT session_id
  FROM events
  WHERE session_id IN (
    SELECT session_id FROM events WHERE ts BETWEEN @from AND @to
  )
  GROUP BY session_id
  HAVING MIN(ts) >= @from`;

// The whole condition, not just the list of sessions — because the
// `ts >= @from` in front of it is not optional and must not be
// separable from the membership test.
//
// **Why the floor is there.** Without it, the outer query is bounded by
// nothing but its own `event = ...`, so SQLite walks every matching row
// ever recorded and lets the period in only through which sessions
// qualify. The work is then proportional to all history rather than to
// the window: measured on 5,000,000 events, top referrers over 7 days
// took 2,101 ms without it and 608 ms with it, returning the same
// 39,978 sessions. See "A real load test" in docs/decisions.md.
//
// **Why it cannot change an answer.** The subquery admits a session
// only when `MIN(ts) >= @from` over *all* of that session's events, so
// no row of a qualifying session is older than @from and the floor can
// never exclude one. That holds whatever the timestamps look like:
// `MIN(ts)` is the lexically smallest value of the same column under
// the same collation the floor compares against, so it does not depend
// on every row being well-formed ISO-8601.
//
// **Why there is no ceiling, and must not be.** A session that started
// inside the period is read in full, including events after @to —
// that is where a session starting late in the window genuinely exited
// (see the straddling-session tests in content.test.ts). `ts <= @to`
// would look symmetrical, be wrong, and quietly move numbers.
// Parenthesised as a whole: it is a bare AND-chain otherwise, and one
// pasted after an OR — or inside a NOT — would re-associate into
// something that still runs and quietly answers a different question.
export const IN_SESSION_STARTED_IN_PERIOD = `(ts >= @from
    AND session_id IN (${SESSIONS_STARTED_IN_PERIOD}))`;
