# The client script

Embedding the script, tracking events, and defining your own.

## Embedding the client script

Put the config object and the script tag early in `<head>`:

```html
<script>
  window.genugAnalyticsConfig = {
    enableAutoPageTracking: true,
  };
</script>
<script defer src="https://data.your-domain.com/client.js"></script>
```

The script finds your server from its own `src`. The config is read
once, at load, so it must come before the tag. `defer` keeps the tag
from slowing your page down.

The config options:

- **`consent`** (default unset): whether the visitor agreed to
  tracking across days. Leave it unset until your consent manager has
  answered. Set `true` on accept, and `false` only on an explicit
  decline or withdrawal, because `false` deletes an existing
  `genug_vid` cookie. Unset leaves a returning visitor's cookie alone.
  To switch without a reload, call
  `window.genugAnalytics.setConsent(true)` from your banner's callback.
- **`enableAutoPageTracking`** (default `false`): see
  [tracking page loads](#tracking-page-loads).
- **`enableAutoLinkTracking`** (default `false`): see
  [outbound links and downloads](#tracking-outbound-links-and-downloads).
- **`enableAutoRouteTracking`** (default `false`): see
  [route changes](#tracking-single-page-app-route-changes).

Without consent, a visitor gets a new ID every day. So "new versus
returning" is only reliable for consented visitors, or for returns on
the same day.

### Loading only after consent

By default a visitor who rejects is still counted, under the daily ID
([privacy](privacy.md#how-visitors-are-told-apart)). `consent: false`
changes _how_ they are identified, not _whether_. To collect nothing
without consent, leave the script tag out and load it from your
consent manager:

```html
<script>
  const GENUG_SRC = "https://data.your-domain.com/client.js";

  // Call from the "accept" callback, and on every page load where
  // consent is already stored.
  function startAnalytics() {
    const running = window.genugAnalytics && !window.genugAnalytics.q;
    if (running) {
      // Accepted again after withdrawing, on the same page.
      window.genugAnalytics.optIn();
      window.genugAnalytics.setConsent(true);
      return;
    }
    if (window.genugAnalytics) return; // already loading
    window.genugAnalyticsConfig = {
      consent: true,
      enableAutoPageTracking: true,
    };
    // Clears the opt-out an earlier withdrawal left, before the first
    // page view is sent.
    window.genugAnalytics = { q: [["optIn", []]] };
    const script = document.createElement("script");
    script.src = GENUG_SRC;
    document.head.append(script);
  }

  // Call from the "withdraw" callback.
  function stopAnalytics() {
    const api = window.genugAnalytics;
    if (!api) return;
    if (api.q) api.q.push(["optOut", []]);
    else api.optOut();
  }
</script>
```

On reject, nothing loads and nothing is sent. On withdrawal, `optOut()`
stops the script and deletes the `genug_vid` cookie. It leaves the
opt-out flag behind, which is why `startAnalytics()` queues `optIn()`
first. The [privacy policy text](privacy.md#text-for-your-privacy-policy)
says what to change for this mode.

Expect far lower numbers: everyone who rejects or ignores the banner is
missing from all of them.

## Tracking events

### From JavaScript

```js
window.genugAnalytics.track("product_added_to_cart", {
  product_id: "123",
  value: 49.9,
});
```

`track(event, props)` sends a registered event right away. The props
must match the event's definition, or the server rejects it.

#### Calling `track()` before the script has loaded

`track()` throws if `client.js` hasn't arrived yet. If you call it from
inline code, or from a framework that may run first, put this stub
_before_ the script tag:

```html
<script>
  window.genugAnalytics = {
    q: [],
    track: function () {
      window.genugAnalytics.q.push(["track", [].slice.call(arguments)]);
    },
    setConsent: function () {
      window.genugAnalytics.q.push(["setConsent", [].slice.call(arguments)]);
    },
    optOut: function () {
      window.genugAnalytics.q.push(["optOut", [].slice.call(arguments)]);
    },
  };
</script>
<script defer src="https://data.your-domain.com/client.js"></script>
```

Queued calls are replayed in order once the script loads. You don't
need the stub if you only call `track()` from clicks and form submits.

**A consent manager usually answers after the first page view.** That
page view is then recorded without consent. Everything after it is
consented, and a returning visitor's cookie survives because `consent`
was unset rather than `false`. To get the first page view in as
consented too, either set `window.genugAnalyticsConfig.consent = true`
inline when your site already knows the answer, or use the stub above
so `setConsent(true)` is replayed first.

#### Events that must not count twice

For an event like a completed order, pass a third argument that
uniquely identifies it. A repeat with the same value, from a refresh or
the back button, is dropped:

```js
window.genugAnalytics.track(
  "order_completed",
  { value: 129.9, currency: "EUR" },
  "3f9c2a…", // idempotency key
);
```

Don't use the order number itself: it links the session to a named
customer. Have the shop's backend make an HMAC of it with a secret the
shop keeps. A plain hash isn't enough, because order numbers can be
guessed one by one. The same goes for an `order_id` prop. Most events
need no third argument.

### From HTML attributes (no JS required)

A click anywhere inside a tagged element sends the event:

```html
<button data-genug-on-click="cta_click" data-genug-props='{"plan":"pro"}'>
  Upgrade
</button>
```

`data-genug-props` is optional. Invalid JSON there logs a warning and
sends empty props. Use a `<button>` or `<a href>`, so keyboard users
trigger it too; a tagged `<div>` only works for them if you made it
keyboard-accessible yourself.

This is also how you track **internal links**. There is no built-in
event for them, so define your own and tag the links you care about:

```html
<a
  href="/pricing"
  data-genug-on-click="internal_link_click"
  data-genug-props='{"target_url":"/pricing","link_text":"See pricing"}'
>
  See pricing
</a>
```

### Tracking page loads

Nothing fires on page load by default. Two ways to turn it on:

1. **`data-genug-on-load="event_name"`** (with optional
   `data-genug-props`) on `<html>` fires that event once, at load.
2. **`enableAutoPageTracking: true`** fires the built-in `page_view`,
   with the page title and language. It is ignored if the attribute
   above is present, so a page never fires both.

### Tracking single-page-app route changes

In a single-page app, page loads fire only once. Add
`enableAutoRouteTracking: true` so each route change fires the same
event again:

```html
<script>
  window.genugAnalyticsConfig = {
    enableAutoPageTracking: true,
    enableAutoRouteTracking: true,
  };
</script>
```

It repeats whatever page loads fire, so on its own it does nothing and
warns in the console. It counts `history.pushState()` and back/forward
when the path or query string changes. It does not count
`replaceState()`, a change of the `#hash` alone, or the route you are
already on. Hash-routed apps (`#/about`) are therefore not tracked.

It's off by default because many sites use `pushState` for things that
aren't navigation, like a lightbox or a filter. The referrer stays the
external site that sent the visitor.

### Tracking outbound links and downloads

Set `enableAutoLinkTracking: true` to record clicks on links that leave
your site, or that point at a file:

```html
<script>
  window.genugAnalyticsConfig = { enableAutoLinkTracking: true };
</script>
```

- A link to another host fires **`outbound_link_click`** with
  `target_url`, `target_host` and `link_text`.
- A link to a file fires **`file_download`** with `file_url`,
  `file_extension` and `link_text`. A file is a link with a `download`
  attribute, or one whose URL ends in a common extension (`.pdf`,
  `.zip`, `.docx`, …).

Worth knowing:

- An outbound link to a file counts as a download.
- Middle-click counts; right-click doesn't.
- Internal links aren't tracked; tag them yourself (above).
- A link with its own `data-genug-on-click` fires only that event. A
  tagged element _around_ a link fires both.
- Both URLs are filtered like page URLs, so a signed download link
  loses its signature.

Ask your agent _"what are people downloading?"_ or _"where is my
traffic leaving to?"_.

### Limits on what you can send

- A request body is at most **16 KB**.
- `url` and `referrer` are at most **2048 characters**. `url` must be an
  absolute `http` or `https` URL; `referrer` is empty, `http`, `https`
  or `android-app`.
- Event names and idempotency keys are at most **128 characters**.
- A list prop holds at most **50 values**.
- Query parameters not in `KEPT_QUERY_PARAMS` (default: the six
  `utm_*`) are removed, by the script and again by the server.
- The `#fragment` is removed unless it is in `KEPT_HASH_VALUES` (empty
  by default).

Too large gets a `413`. Anything invalid gets a `400` and shows up in
`get_top_rejected_events` with the reason, so a broken integration is
visible.

## Defining your own events

The easiest way is the cockpit. In its **Schema registry** card, press
**Register new event**, name and describe it, and add each prop by
picking a type. It is live at once.

Behind the form is one JSON file per event, named for it, in
`/data/events/` (`EVENTS_PATH`). You can write the file yourself and
press **Reload events into system**. No restart, no database change:

```json
{
  "_description": "Fired on the order confirmation page after a successful checkout",

  "order_total": "number",
  "order_total_description": "Order total including tax, in the currency below",
  "order_total_example": 49.9
}
```

The built-ins (`page_view`, `outbound_link_click`, `file_download`) are
copied there when the folder is empty, usually on first start. After
that nothing overwrites the folder, so you can edit, rename or delete
them. An event you add to your own image's
`packages/schema-registry/events/` therefore doesn't reach a volume
that already has files; put it on the volume too. A broken file is
skipped and shown in the cockpit; it doesn't stop the server.

**Reset events**, in the cockpit's danger zone, empties the folder and
copies the built-ins back. Your own events and your edits go with it.
Stored rows stay, but rows under a name that no longer exists match no
question asked by name. The cockpit lists them afterwards.

**[recipe-add-event.md](recipe-add-event.md)** covers the rest: what
the cockpit can change on a live event, renaming without losing data,
deleting, and resetting to the built-ins.
