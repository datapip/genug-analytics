# Recipe: add a tracked event

Follow this end to end to teach your deployment a new event type. It is
one JSON file: no database migration, no new column, ever. Every event
shares one `events` table and stores its own fields as JSON in `props`.

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

**Why the cockpit stops short.** An incoming event must carry every
required prop and no unknown one, or the whole event is rejected. A new
required prop, a deleted prop or a changed type therefore rejects every
event from a site still running the old code, and that reads as a
traffic drop. An optional prop can't do that, so it is the one change
the cockpit makes to an event that already has traffic.

## 1. Add the event

The quickest route is the cockpit: in the **Schema registry** card,
press **Register new event**. Name and describe the event, and add each
prop by picking a type (text, long text, number, true or false),
whether it is required, and whether it holds several values. It is live
when you press Create. The form never takes a rule string and never
offers a role tag.

Behind the form is one JSON file per event, in **`/data/events/`** on
the persistent volume (`EVENTS_PATH`). **The filename is the event
name**: `order_completed.json` defines `order_completed`. To write one
by hand, drop it in and press **Reload events into system**. No restart,
no rebuild.

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

Keys starting with `_` describe the event. Every other key is a prop,
with two companions: `<prop>_description` and `<prop>_example`. JSON has
no comments, so `_note` (or `<prop>_note`) is the stand-in; nothing
reads it.

The built-ins are in the same folder, copied there when it was empty.
Editing one is the same job as adding your own.

### The rule string

A prop's value is a dot-separated rule. The type comes first; the rest
may follow in any order.

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
"string.list"            required list of short strings
"number.list.optional"   optional list of numbers
```

### Rules you cannot break

A file that breaks one is skipped, never a reason to stop the server.
The cockpit's **Schema registry** card names the file and the key.
Until you fix it, that event is rejected as `unknown_event_type`, so
check the cockpit if a custom event stops arriving.

- **No nested objects.** Split them: `order_total` and
  `order_currency`, not `order: { total, currency }`. The query tools
  read one value per prop.
- **Every string is capped**, at 512 characters or 2048 with `long`.
  `/events` is public and prop values reach your agent word for word, so
  an uncapped prop would let a stranger write at length into the
  model's context.
- **`_example` must be a value its own rule accepts.** A `number` prop
  needs `49.9`, not `"49.9"`. The agent reads it to understand your
  data.
- **Write every description for a stranger.** It is what the agent
  grounds its answers in. "The value" tells it nothing; "Order total
  including tax, in the currency below" tells it what it can add up. An
  empty one is rejected.
- **Prop names are lowercase letters, digits and underscores.** Names
  ending in `_description`, `_example` or `_note` are reserved.
- **Name the event for what happened**, not what triggered it:
  `order_completed`, not `confirm_button_click`.
- **One role tag per event, one event per role tag** (below). If you
  copy `page_view.json` instead of renaming it, the second file is
  skipped.

### When a list is the right shape

A list is for **one dimension with several values**: an article's tags,
a product's categories.

```json
{
  "tags": "string.list",
  "tags_description": "Topics this article is filed under",
  "tags_example": ["pricing", "analytics"]
}
```

Breakdowns count each value on its own, so the counts add up to more
than the number of events. A segment on a list matches any session that
carries the value.

It is **not** for values that belong together. A `products` list next
to a `prices` list pairs only by position. Send one event per line
item instead, each with its own `product_id`, `quantity` and
`unit_price`, plus a shared `order_id`. `get_property_sum` adds one
prop, so if revenue matters, send `line_total` as its own prop. With
an idempotency key (below), make the key unique per line item, such as
`${order_id}:${product_id}`, or only the first line is kept.

### Role tags

Three event-level flags tell Genug which event fills a role, so nothing
hardcodes a name: `"_pageView": true`, `"_automaticOutboundClick": true`
and `"_automaticFileDownload": true`. A custom event takes none. You
only touch them when you rename or replace a built-in, and then you
carry the tag to the new file.

**`_pageView` can't be dropped.** Every page-scoped question resolves
through it. If no event carries it, the built-in `page_view` is used
instead and the cockpit says why. The other two are optional: without
them, automatic link and download clicks are rejected, with the
missing tag named in the cockpit.

### Flagging a conversion

`"_conversion": true` marks an event as a business goal: a signup, a
purchase. Any number of events may carry it. `list_event_types` reports
it to the agent; no tool filters by it.

### Editing an event from the cockpit

**Edit**, on each event in the Schema registry card, changes the words
only: the name, the description, and each prop's description and
example. Prop names, types and role tags stay read-only, because they
decide whether an event is accepted. Type a text example as it reads,
and anything else as JSON: `49.9`, `true`, `["news", "product"]`.

**Add a prop** adds an optional prop to a live event. Removing a prop,
or making one required, stays a file edit.

**Delete** removes the event's file. Its stored rows stay, under a name
nothing registers (see below). Deleting the `_pageView` event falls
back to the built-in `page_view`, and the card says so.

If the server couldn't prepare `EVENTS_PATH` and reads the image's
events instead, these buttons are hidden and the card says why.

### Renaming an event

**Rename in the cockpit once you have data.** Edit the event and change
its name. The form knows the old name and the new one, so it offers to
move the stored rows across, with the real count. A file rename can't:
to the server it looks like one event deleted and an unrelated one
added.

**For your own events**, your site sends the name, so change it in your
site's code too. On a live site, keep both definitions for one deploy:
add the new one, deploy the site, then remove the old one.

**For the three built-ins**, the script sends a role, never a name, so
nothing on your site changes. Rename the file, keep its role tag, and
reload.

**Rows stored under the old name stay there** after a file rename. They
still count in totals but match no question asked by name. Rename the
page-view event and its history stops counting as page views. The
cockpit and `get_orphaned_events` report how many rows are stranded.
To move them, rename the event in the cockpit back to the old name,
then forward again with the offer to move them ticked. Or run the update
yourself, after making sure you have a backup:

```sh
docker exec genug node -e '
const db = require("better-sqlite3")(process.env.DB_PATH || "/data/genug.db");
const [from, to] = process.argv.slice(1);
console.log(db.prepare("UPDATE events SET event = ? WHERE event = ?").run(to, from).changes, "rows moved");
' page_view seitenaufruf
```

`0 rows moved` means the old name was wrong; check it against what the
cockpit reports.

## 2. Send it

From your site's JavaScript:

```js
window.genugAnalytics.track("order_completed", {
  order_total: 49.9,
  order_currency: "EUR",
});
```

Or with no JavaScript, on any clickable element:

```html
<button
  data-genug-on-click="order_completed"
  data-genug-props='{"order_total":49.9,"order_currency":"EUR"}'
>
  Buy
</button>
```

### If firing twice would double-count

A refreshed confirmation page fires the event again. Pass a third
argument that identifies the real-world occurrence, and a repeat is
dropped:

```js
window.genugAnalytics.track("order_completed", props, orderKey);
```

Use a keyed hash of the order number, not the number itself (see
[client.md](client.md#events-that-must-not-count-twice)). Your site has
to supply it; a generated value would differ on every refresh.

## 3. Verify

An event file on the volume needs no build. If you added it to the
repo's `packages/schema-registry/events/` instead, run
`npm run build && npm test && npm run lint`, then rebuild the image and
redeploy. It only reaches a volume that is still empty.

1. Fire the event once on the site.
2. Open `/cockpit`. It should appear under **Recent events** with the
   props you sent, and in the **Schema registry** table.
3. If it doesn't, check the rejected counter on the same page. It names
   the reason. The browser never shows a rejection, so the cockpit is
   where you look.
