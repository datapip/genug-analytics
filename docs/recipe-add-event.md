# Recipe: add a tracked event

Follow this end to end to teach your deployment a new event type. It is
one JSON file — no database migration, no new column, ever. Every event
shares one `events` table and stores its own fields as JSON in a `props`
column.

## What's possible where

| Action                                           | File edit            | Cockpit                                 |
| ------------------------------------------------ | -------------------- | --------------------------------------- |
| Create a new event (define props/types)          | ✅                   | ✅ (no traffic yet — nothing to reject) |
| Rename an event                                  | ✅ (rows don't move) | ✅ (offers to move stored rows)         |
| Edit description / prop text & example           | ✅                   | ✅                                      |
| Add an **optional** prop to a live event         | ✅                   | ✅ (forced optional)                    |
| Add a **required** prop, or change a prop's type | ✅                   | ❌                                      |
| Delete a prop                                    | ✅                   | ❌                                      |
| Delete an event (including a role-tagged one)    | ✅                   | ✅                                      |
| Assign or move a role tag (`_pageView` etc.)     | ✅                   | ❌                                      |
| Flag or unflag `_conversion`                     | ✅                   | ❌ (shown as a badge, not settable)     |
| Reset all events to the built-ins                | ✅ (manual)          | ✅ (danger zone)                        |

**Why the cockpit stops short of the file for some of these:** every
event's schema is a `z.strictObject` — an incoming event must carry
every required prop and no unrecognized one, or the _whole event_ is
rejected, not just the bad field. Adding a required prop, or deleting
one, means any site still running the old script — cached, not yet
redeployed — starts failing that check on its very next event. Nothing
already stored is touched, but new events from that sender are
rejected until it catches up, and that rejection reads as a traffic
drop unless you check the cockpit's rejected-events counter. An
**optional** prop carries none of that risk — an absent optional key is
indistinguishable from a row from before the prop existed — which is
why it's the one shape change the cockpit is allowed to make to an
event that already has traffic. The rest of this recipe explains each
row's mechanics in full; "Editing an event from the cockpit" below
covers the words-only line, and "Renaming an event" covers what a
cockpit rename can do that a file rename can't.

## 1. Add the event

The quickest route is the cockpit: open the **Schema registry** card,
press **Register new event**, and fill in the form. You name the event, describe
it, and add each prop by picking a type — text, long text, number,
true or false — and ticking whether it is required and whether it holds
several values. Press Create and it is live: the server writes the file
and reloads the registry itself.

The form is deliberately narrow. It will not let you type a rule string
(it composes one from what you picked) and it will not let you claim a
role tag — see "Role tags" below for why that one stays a file edit.

The rest of this step is the file the form writes — worth reading
whichever route you take, and the only route when you are preparing an
event outside a browser.

Create one JSON file per event. **The filename is the event name** —
`order_completed.json` defines `order_completed`. There is nothing else
to register: the server reads the directory at startup.

It goes in **`/data/events/` on the persistent volume**
(`EVENTS_PATH`). Drop the file in, then press **Reload events into system** in
the cockpit's Schema registry card. No restart and no rebuild, so this
works with a stock image.

That directory holds every event, including the built-ins — the server
copies them there the first time it finds it empty, and never touches
it again. Editing a built-in is the same job as adding your own.

```json
{
  "_description": "Fired on the order confirmation page after a successful checkout",

  "order_total": "number",
  "order_total_description": "Order total including tax, in the currency below",
  "order_total_example": 49.9,

  "order_currency": "string",
  "order_currency_description": "ISO 4217 currency code",
  "order_currency_example": "EUR",

  "payment_method": "string.optional",
  "payment_method_description": "How the order was paid, if known",
  "payment_method_example": "card"
}
```

Keys starting with `_` describe the event itself. Every other key names
a prop and declares its shape, and each prop carries two companions:
`<prop>_description` and `<prop>_example`.

Plain JSON has no comments, so `_note` is the format's stand-in. Put one
on the event, or on any prop as `<prop>_note`. Nothing reads them — not
the server, not the agent.

### The rule string

A prop's value is a dot-separated rule. The first segment is the type
and is required; the rest may follow in any order.

| Part                   | Words                         | Default    |
| ---------------------- | ----------------------------- | ---------- |
| Type (first, required) | `string`, `number`, `boolean` | —          |
| Optionality            | `required`, `optional`        | `required` |
| Length (strings only)  | `short` (512), `long` (2048)  | `short`    |
| Shape                  | `list` (up to 50 values)      | one value  |

```
"string"                 required, up to 512 characters
"string.long"            required, up to 2048 — for a prop holding a URL
"number.optional"        optional number
"boolean"                required true/false
"string.list"            required list of short strings
"number.list.optional"   optional list of numbers
```

`required` and `short` are accepted explicitly even though they are the
defaults, if you would rather spell them out.

### Rules you cannot break

The server checks every file at startup, with a message naming the file
and the key. A file that fails is skipped and listed in the cockpit's
**Schema registry** card — never a reason to stop the server, because a
typo hand-edited on a live server must not take collection down for
every other event.

A skipped file is not silent, but it is indirect: its events keep
arriving and keep being rejected as an unknown type. Check the cockpit
if a custom event stops working.

Two files may not claim the same role tag (`_pageView`,
`_automaticOutboundClick`, `_automaticFileDownload`) — the second one
alphabetically is skipped and reported. If you _copy_ `page_view.json`
rather than renaming it, this is what you will see. And if the file
carrying `"_pageView": true` is the one that failed, the built-in
page-view event is registered as a stand-in so page views keep being
recorded, with a line in the cockpit saying so.

- **No nested objects** — the format cannot express one. Splitting is
  the fix: an order becomes `order_total` + `order_currency`, not
  `order: { total, currency }`. The reason is that `get_events_by_property` and
  `get_property_sum` read a single `json_extract('$.key')` value, and
  SQLite hands back a nested object as one opaque string.

- **Every string prop is length-capped**, at 512 unless you write
  `long`, and there is no way to opt out. This isn't tidiness.
  `POST /events` is public and unauthenticated, and `get_recent_events`
  hands stored prop values to your AI agent word for word — so an
  uncapped text prop would let any stranger write as much text as they
  like straight into the model's context. The cap doesn't make that
  impossible, it just takes away the room to write at length.

- **`_example` must be a real value that its own rule accepts.** It is
  not decoration: the agent reads it to understand your data, so an
  example the schema would itself reject is a lie about it. A
  `number` prop needs `49.9`, not `"49.9"`.

- **Every description must be written for a stranger.** The registry is
  what the AI agent grounds itself in before answering questions.
  `"the value"` tells it nothing; `"Order total including tax, in the
currency below"` tells it what it can and cannot add up. Blank or lazy
  descriptions are the single most common way a customised deployment
  ends up giving bad answers, and an empty one is rejected outright.

- **Prop names may only contain lowercase letters, digits and underscores.**
  Anything else cannot be read back by `get_events_by_property`, so the prop
  would store fine and then be invisible. Names ending in
  `_description`, `_example` or `_note` are reserved — those always
  belong to the prop named before them.

- **A list holds at most 50 values**, each capped like an ordinary prop
  of its type — `string.list` caps every value at 512 characters, not
  the list as a whole.

- **Name the event for what happened, not for what triggered it.** The
  same event may later be fired by a click, a page-load attribute, or a
  manual `track()` call. `order_completed`, not `confirm_button_click`.

An event with no file is rejected at ingestion with
`unknown_event_type`, visible via the `get_top_rejected_events` tool and
the cockpit's rejected counter.

### When a list is the right shape

A list is for **one dimension with several values**: the tags on an
article, the categories a product sits in, the authors of a post.
`get_events_by_property` expands it so each value is counted on its own, and
`get_property_sum` adds every value up.

```json
{
  "tags": "string.list",
  "tags_description": "Topics this article is filed under",
  "tags_example": ["pricing", "analytics"]
}
```

It is **not** for several dimensions that vary together. A `products`
list alongside a `prices` list pairs only by position: nothing enforces
that the two are the same length, and "revenue per product" needs that
pairing to be real. Line items are separate events sharing an `order_id`
prop, one per line, each carrying its own product and price. How you
model your data is your choice — this is the way that holds up when you
later ask which product earns the most.

A cart with three products, for example, is three
`product_added_to_cart` events (fired as each is added, or all three
when the cart page loads), not one `cart_updated` event holding a
three-item list — the format has no nested-object shape to hold "product
X at price Y, quantity Z" as one unit anyway:

```json
{
  "_description": "Fired when a product is added to the cart",
  "order_id": "string",
  "order_id_description": "The cart/order this line item belongs to, for grouping line items back together",
  "order_id_example": "cart_8f2c1a",
  "product_id": "string",
  "product_id_description": "SKU of the added product",
  "product_id_example": "sku_1042",
  "quantity": "number",
  "quantity_description": "How many units were added",
  "quantity_example": 2,
  "unit_price": "number",
  "unit_price_description": "Price per unit, in the store's currency",
  "unit_price_example": 24.95
}
```

`get_events_by_property` grouped by `order_id` then answers "what was in
this cart". `get_property_sum` sums one prop, not a product of two, so if
"total revenue" matters, send the computed `line_total`
(`unit_price × quantity`) as its own prop rather than expecting it to be
derived later.

**If you also want idempotency here** (see "If firing twice would
double-count" below) — a purchase confirmation page firing all three
line items on refresh — the key has to be unique **per line item**, not
per order. Deduping is on the `(event, idempotencyKey)` pair, scoped to
one event type: `order_id` alone as the key for all three
`product_added_to_cart` events collides with itself, and only the first
of the three is kept, silently, since `ON CONFLICT ... DO NOTHING` isn't
a rejection the cockpit or `get_top_rejected_events` can see. Use
`${order_id}:${product_id}` (or an existing line-item id) instead.

Two things to expect when you break down a list:

- **The counts add up to more than the number of events.** An article
  with three tags is counted under all three, so a percentage out of the
  event count is not meaningful.
- **A segment's event condition filters on "carries this value", not
  "equals it".** One article tagged both `pricing` and `analytics`
  matches a segment for either, so two segments can each contain the
  same session.

### Role tags

Three event-level flags mark an event as filling a role, so nothing has
to hardcode an event name: `"_pageView": true`,
`"_automaticOutboundClick": true`, `"_automaticFileDownload": true`. At
most one registered event may carry each, checked at startup.

You only need these if you **rename or replace one of the three built-in
events** — see "Renaming an event" below, where the only tag-specific
part is carrying the tag across to the new file. A custom event like
`order_completed` takes no tag.

**`_pageView` is the one you cannot drop.** Exactly one registered event
must carry it; if none does, the built-in `page_view` is registered as a
stand-in and the cockpit says why. Every page-scoped query resolves
through it. If your deployment has no page-view concept, keep the file anyway
and never fire the event — the numbers then read as zero, which is true,
rather than as "not configured", which nothing downstream has to
special-case.

Note it is _not_ named `_automaticPageView`, unlike the other two. Those
two do nothing but tell the client script which event to record an
automatic click as. `_pageView` marks the event that _means_ a page
view, which every page-scoped query resolves through — and
`enableAutoPageTracking` is off by default, so a deployment firing page
views by hand still needs it.

The other two are optional. Leave them off and nothing fires those
events; turn `enableAutoLinkTracking` on anyway and those clicks are
rejected as `unknown_event_type`, visible in `get_top_rejected_events`
and on the cockpit, saying which tag is missing — the same place a
mistyped custom event shows up.

### Flagging a conversion

`"_conversion": true` marks an event as counting toward a business
goal — a signup, a purchase, a newsletter subscribe. Unlike a role tag,
any number of events may carry it: most sites have several goals, not
one, and nothing resolves behaviour through this flag the way
`_pageView` and the client rely on the three above, so there is no
uniqueness rule to enforce.

```json
{
  "_description": "Fired when a visitor completes the signup form",
  "_conversion": true,
  "plan": "string",
  "plan_description": "Which plan the visitor signed up for",
  "plan_example": "pro"
}
```

`list_event_types` reports it, so the agent can tell a conversion event
from any other without guessing from the name or description. It's
metadata only today — no built-in query filters or ranks by it — so
treat it as grounding for the agent to reason with, not a switch that
changes what a tool returns.

### Editing an event from the cockpit

The **Schema registry** card has an **Edit** button on each event. It
changes the words and only the words: the event's name, its
description, and each prop's description and example.
Saving rewrites the file and reloads the registry, so the change is
live immediately.

Prop names, types and role tags are deliberately read-only there. Those
decide whether an incoming event is accepted, and a browser form that
can change them can stop collection with one typo — that is what the
file is for.

**Register new event** is the looser one, and the difference is traffic, not
the form. A name nothing has sent yet cannot reject an event or strand
a history, so that form does define props: a type from a list of four,
required or not, one value or several. It still never takes a rule
string — the server composes it — and it still never offers a role tag.

An example for a text prop is typed as it reads. For any other kind —
a number, a true/false, a list — type it as JSON: `49.9`, `true`,
`["news", "product"]`.

**Add a prop**, on an event that already has traffic, is the one
exception to words-only: it takes the same closed type picker as
Register new event, but there is no "Required" checkbox to tick — the
new prop is always optional. A prop nobody is sending yet cannot reject
traffic that is already arriving, whereas a _required_ one would, the
same way a changed rule string would, so the form never offers the
choice. Removing a prop, or making one required, stays a file edit for
the same reason **Edit** never offers those either.

**Delete**, also on the event's row, removes its file — the one-event
version of the danger zone's Reset below. Rows already stored under
that name are left exactly where Reset leaves them: still in the
table, matching nothing, the ordinary orphaned-events case.

Deleting the event flagged `_automaticOutboundClick` or
`_automaticFileDownload` is safe outright: the client sends the role,
never a name, for these (see "Role tags" above), so the next automatic
click or download is simply rejected as `unknown_event_type` until
another event claims the tag — visible in the cockpit's rejected
counter, the same place a mistyped event shows up.

Deleting the one flagged `_pageView` usually falls back to the built-in
`page_view` definition and keeps recording under that name — the
Schema registry card says so, since it is a real change from what you
had, not a silent one. The delete is refused instead, leaving the file
exactly as it was, in the one case that fallback cannot use: another
event already occupying the built-in's own name. That state isn't
reachable from the cockpit's own forms — it means a file was hand-edited
on the volume — but if you're in it, free up the name first (rename or
remove whatever else is using it), then delete.

Both Edit and Register new event are missing if the server could not
prepare `EVENTS_PATH` and is reading events from the image instead; the
card says so, since anything written there would not survive a
restart. Add a prop and Delete are gated the same way.

### Renaming an event

Rename it in the cockpit, or rename the file — and what else you have
to do depends on which kind of event it is.

**Prefer the cockpit once you have data.** Open the **Schema registry**
card, press **Edit** on the event, and change the name. The form still
holds the old name while you type the new one, so it knows both and can
offer to carry the stored events across — ticked by default, with the
real count. That is the one thing a file rename cannot do, for the
reason spelled out further down.

The rest of this section is the file route, and the manual repair if
you took it.

**An event you added yourself** — your site sends that name, in
`track("order_completed", ...)` or `data-genug-on-click="order_completed"`.
So renaming the file is half the job: until you also change the name in
your site's code and deploy it, your site keeps sending the old name and
those events are rejected as `unknown_event_type`. Rename both in the
same sitting.

Whichever you do first, there is a gap — the server reloads without the
old name before the site stops sending it, or the site starts sending
the new name before the server knows it. On a site with live traffic,
close the gap by keeping **both** files for one deploy: add the new one,
deploy the site change, then delete the old one. Both names are accepted
in between, so nothing is rejected. (The three built-in events skip
this entirely — see below.)

**One of the three built-in events** — nothing to change on your site.
Their files are on your volume like any other (the server puts them
there on first start), so this is an ordinary rename: `page_view`
becoming `seitenaufruf` is `seitenaufruf.json` carrying
`"_pageView": true`. Rename the file, don't copy it — leaving both
means two events claiming one role tag, and the second is skipped.
Reload, and every page-scoped tool follows. There is no deploy and no
cache wait, because the script never sends a name for these three — it
sends the role, and the server looks up what you call that event on
every request. A browser holding a cached copy of the script from before
the rename keeps working straight through it.

**If you renamed the file, your existing data stays under the old
name.** Rows written before the rename keep it, and nothing registers
that name any more. (A cockpit rename offers to move them, which is why
it is the better route.)

They are not simply gone, which is the awkward part. They still count
toward totals, and `get_top_events` still lists them under the old name
— but nothing will accept that name as an argument, and anything keyed
on a registered name skips them. Rename the **page-view** event and its
whole history stops counting as a page view: top pages, entry, exit and
bounce pages lose it, and those events are counted as interactions
instead. The totals stay believable while the breakdown is wrong, which
is harder to notice than a number dropping to zero.

You are told, rather than having to remember this: the cockpit's
**Schema registry** card says how many events are stored under an
unregistered name, and the agent can answer the same question through
`get_orphaned_events`.

Neither can fix it for you, and the reason is not caution but
ignorance. **A file rename tells the server nothing.** A file with one
name stopped existing and a file with another started; deleting
`page_view` and separately adding an unrelated `seitenaufruf` looks
exactly the same from inside. Only you know the two are the same event,
so only you can say which old name maps to which new one.

This is precisely what the cockpit's Edit button has that a file rename
does not: you type the new name into a form that still holds the old
one, so both halves are known and it can offer to move the rows. If you
have already renamed the file, that moment has passed — but you can
recreate it: rename the event in the cockpit to the name the stranded
rows carry, which hands them back, then rename it forward again with
the offered checkbox ticked. (Renaming rows is deliberately not
something an AI agent can do through a tool — rewriting every row in
the table is not a decision to delegate.)

The other way back is one statement you run yourself:

```sql
UPDATE events SET event = 'seitenaufruf' WHERE event = 'page_view';
```

The runtime image has no `sqlite3` binary, so run it through the
`better-sqlite3` the server already uses. The old and new names go in as
arguments, so there is no nested quoting to get wrong:

```sh
docker exec genug node -e '
const db = require("better-sqlite3")(process.env.DB_PATH || "/data/genug.db");
const [from, to] = process.argv.slice(1);
console.log(db.prepare("UPDATE events SET event = ? WHERE event = ?").run(to, from).changes, "rows moved");
' page_view seitenaufruf
```

(`genug` is the container name. Running from a clone rather than Docker,
drop the `docker exec genug` and set `DB_PATH` yourself.)

**Leave the server running.** `event` is indexed, so this is a short
write, and SQLite's WAL mode is built for a second process writing
alongside the first. Stopping the container would also mean you could no
longer `docker exec` into it.

**It prints how many rows it moved.** `0 rows moved` means the old name
was wrong — check it against what the cockpit reported rather than
running the command again with a guess.

A backup is worth having first, because this has no undo: the daily one
is already in `/data/backups` (see "Restoring one" in [operations.md](operations.md)), and
copying today's database file somewhere safe takes a second if the last
few hours matter.

## 2. Send it

From your site's JavaScript:

```js
window.genugAnalytics.track("order_completed", {
  order_total: 49.9,
  order_currency: "EUR",
});
```

Or with no JavaScript at all, on any clickable element:

```html
<button
  data-genug-on-click="order_completed"
  data-genug-props='{"order_total":49.9,"order_currency":"EUR"}'
>
  Buy
</button>
```

### If firing twice would double-count

A confirmation page that the visitor refreshes or back-navigates to
will fire the event again, and `get_property_sum` will add the revenue
twice. Pass a third argument that identifies the real-world occurrence
— a keyed hash of your order id, not the id itself (see
[client.md](client.md#from-javascript)):

```js
window.genugAnalytics.track("order_completed", props, orderKey);
```

A second event with the same `(event, idempotencyKey)` pair is silently
dropped. Your deployment has to supply this value; the client cannot
generate it, because a generated value would differ on every refresh
and defeat the purpose.

## 3. Verify

```sh
npm run build && npm test && npm run lint
```

Then rebuild and redeploy, and confirm end to end:

1. Fire the event once on the site.
2. Open `/cockpit` — it should appear under **Recent events** with the
   props you sent, and in the **Schema registry** table.
3. If it does not, check the rejected counter on the same page. A
   mismatch between your `track()` call and the registered schema shows
   up there with the reason.

`sendBeacon` never surfaces a server response, so a rejected event is
invisible in the browser. The cockpit is where you look.
