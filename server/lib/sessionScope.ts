// Which sessions belong to a period, for queries about a whole session:
// where it entered, where it left, whether it bounced, how long it
// lasted.
//
// A session belongs to the period its first event is in, and all of its
// events are then read, including any after `to`, since that is where a
// session starting late in the period really ended. Taking only the
// events inside the period would be wrong at the edges: a session that
// began before `from` would get a wrong entry page, and one with three
// page views before `from` and one after would look like a bounce.
//
// Volume queries (the traffic summary, the per-day trend) instead count
// sessions active in the period, because they answer "how many sessions
// were there on Tuesday"; their descriptions say so.
//
// Uses the ts index and the (session_id, ts) index, so sessions without
// events in the period are never scanned.
const SESSIONS_STARTED_IN_PERIOD = `
  SELECT session_id
  FROM events
  WHERE session_id IN (
    SELECT session_id FROM events WHERE ts BETWEEN @from AND @to
  )
  GROUP BY session_id
  HAVING MIN(ts) >= @from`;

// The full SQL condition, including `ts >= @from`, so the two parts
// can't be used separately.
//
// **Why `ts >= @from` is there.** Without it SQLite reads every matching
// row ever stored and only then filters by session, so the work grows
// with all history instead of with the period. On 5,000,000 events, top
// referrers over 7 days took 2,101 ms without it and 608 ms with it, with
// the same result. See "A real load test" in docs/decisions.md.
//
// **Why it can't change a result.** A session only qualifies when the
// earliest of all its events is at or after @from, so none of its rows
// is earlier than @from.
//
// **Why there is no `ts <= @to`, and must not be.** A session that
// started in the period is read in full, including events after @to,
// because that is where a session starting late really ended (see the
// tests in content.test.ts). Adding `ts <= @to` would look tidy but
// quietly change the numbers.
//
// The whole condition is in parentheses: pasted after an OR or inside a
// NOT, a bare chain of ANDs would group differently and quietly answer a
// different question.
export const IN_SESSION_STARTED_IN_PERIOD = `(ts >= @from
    AND session_id IN (${SESSIONS_STARTED_IN_PERIOD}))`;
