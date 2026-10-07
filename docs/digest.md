# A weekly digest

Genug has no dashboard to open and no email to send. A digest is a
prompt you give your agent once a week. It calls the tools, checks that
each change is real, and writes a short summary. The prompt lives with
you, so you can change what it asks for.

## The prompt

Paste this into your AI client. Change the last line to suit.

```text
Write my weekly analytics digest for last week (Monday to Sunday).

1. Call get_collection_health first. If a verdict is longer_than_usual,
   say so at the top and tell me the numbers below may be too low. It is
   a reason to look, not proof that tracking broke.
2. Call get_traffic_change for last week. Report sessions and page views.
   Say "up", "down" or "no real change" from its verdict, not from the
   raw percentage.
3. Call get_top_pages, get_top_referrers and get_top_events for the same
   week. Name what is new or missing compared with usual.
4. For any event I care about, call get_traffic_change again with that
   event.
5. Check the deployment context for history notes that explain a change.

Keep it under 150 words. Lead with what changed and why it might have.
If nothing changed, say that in one line.
```

## Why it uses `get_traffic_change`

Comparing two weeks by hand makes small numbers look dramatic: 4 → 6
visits is +50% and means nothing. `get_traffic_change` compares the week
with the same week over the last four and returns a verdict, so a quiet
week reads as quiet. When it says `too_few_to_tell` or
`too_little_history`, the digest should say that instead of quoting a
percentage.

## Running it each week

Genug schedules nothing. Use whatever your client offers: a scheduled
task, a saved prompt, or a reminder to paste it. The tool results go to
the model vendor like any other question (see [what leaves your
server](mcp.md#what-leaves-your-server-when-you-ask)).
