# The client script

Embedding the script, tracking events, and defining your own.

## Embedding the client script

Add the config object (optional, but see below) and the script tag,
early in `<head>`:

```html
<script>
  window.genugAnalyticsConfig = {
    enableAutoPageTracking: true,
  };
</script>
<script defer src="https://data.your-domain.com/client.js"></script>
```

The script reads its own `<script src>` to find your server — no
separate config attribute needed, and this still works with `defer`.
`window.genugAnalyticsConfig` must be set _before_ this tag, since it's
only read once, at load.

`defer` is there so the tag never delays your page. Without it a
`<script src>` in `<head>` blocks rendering until the file arrives, on
every page load — and `client.js` is deliberately cached for only an
hour, which makes that a real round trip to your collector rather than
a cache hit for a good share of visits.
Deferred scripts still run before `DOMContentLoaded`, so what you give
up is only the visitor who leaves before the HTML finished parsing.
Analytics is not worth a slower site; drop the attribute if you
disagree.

- **`consent`** (default unset): whether the visitor has consented to
  persistent tracking. Leave it unset until your consent manager has
  actually answered — that's a real third state, distinct from `false`,
  and it's what a returning visitor's existing persistent cookie
  survives (see [what is stored](privacy.md#what-actually-gets-stored)). Set it to `true` once
  they accept, and to `false` only for an explicit decline or
  withdrawal, since `false` actively removes any existing cookie. Call
  `window.genugAnalytics.setConsent(true)` later (e.g. from a cookie-banner
  "Accept" callback) to switch a visitor over without a page reload.
  Note: because the consentless hash rotates daily, the
  `get_new_vs_returning_visitors` MCP tool can only reliably tell new
  from returning visitors for consentful (`consent: true`) traffic, or
  same-day returns either way — a consentless visitor who comes back
  tomorrow looks "new" again every time.
- **`enableAutoPageTracking`** (default `false`): see "Tracking page
  loads" below.
- **`enableAutoLinkTracking`** (default `false`): see "Tracking outbound
  links and downloads" below.
- **`enableAutoRouteTracking`** (default `false`): see "Tracking
  single-page-app route changes" below.

### Loading only after consent

By default a visitor who clicks "Reject" is still counted, under the
daily hash (see [privacy](privacy.md#running-without-a-consent-banner)).
`consent: false` changes _how_ they are identified, not _whether_.
If you or your client want no analytics at all without consent, don't
put the script tag in the page. Load it from your consent manager
instead:

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

On reject, nothing loads and nothing is sent. On withdrawal,
`optOut()` stops the script on the current page and removes the
`genug_vid` cookie. It also leaves the `genug_optout` flag, which is
why `startAnalytics()` queues `optIn()` first.

Consent (Art. 6(1)(a) GDPR, § 25(1) TDDDG) is then the basis for the
analytics. It must be valid under Art. 7 GDPR: withdrawing must be as
easy as accepting. Server logs still need their own basis, usually
Art. 6(1)(f). The [privacy policy text](privacy.md#text-for-your-privacy-policy)
says what to change for this mode.

The cost: every visitor who rejects or ignores the banner is missing
from every number. Expect far lower counts than consentless mode gives.

## Tracking events

### From JavaScript

```js
window.genugAnalytics.track("product_added_to_cart", {
  product_id: "123",
  value: 49.9,
});
```

`track(event, props)` sends any registered event type immediately.
`props` must match that event's schema (see [Defining your own events](#defining-your-own-events)
below) or the server rejects it.

#### Calling `track()` before the script has loaded

`client.js` is a separate request, so your own inline code can run
before it arrives — and `window.genugAnalytics.track(...)` throws if the
script isn't there yet. If you call `track()` from inline code, or from
a framework that may run before the tag loads, add this small stub
_before_ the `<script src>` tag:

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

Calls made before the script loads are queued and replayed, in order,
as soon as it initialises — including `setConsent` and `optOut`, so
consent granted early, or an opt-out remembered from a previous visit,
still applies to everything queued behind it. You don't need this
if you only ever call `track()` from user interactions (a click
handler, a form submit), which by definition happen after load.

**A consent manager that calls `setConsent(true)` from its own callback
usually runs _after_ `client.js` has already fired the page view — and
that's fine.** Leaving `consent` unset (rather than `false`) until your
consent manager answers is exactly what it's for: an unanswered request
is never treated as a rejection, so a returning, already-consented
visitor's persistent ID survives it (see [what is stored](privacy.md#what-actually-gets-stored)).
The only cost is that this one page view is recorded consentless, since
consent genuinely wasn't confirmed yet when it fired.

If you'd rather that first event be recorded as consentful too, either
of these gets it in before the auto page-view fires:

- Set `window.genugAnalyticsConfig.consent = true` inline before the
  script tag, if your site already knows the answer at render time from
  its own cookie. It is read once at init, before anything is sent.
- Or use the stub above, so the consent manager's `setConsent(true)` is
  replayed ahead of the page view.

For an event where firing twice would double-count (a completed order,
not a page view), pass a third argument — a value you know uniquely
identifies it:

```js
window.genugAnalytics.track(
  "order_completed",
  { value: 129.9, currency: "EUR" },
  "3f9c2a…", // idempotency key — reuse the same value on a page
  // refresh or back-navigation and the duplicate is silently dropped
);
```

Don't use the order number printed on the invoice. It links the
visitor's session to a named customer in your shop. Use a hash of it
instead, made by the shop's backend with a secret the shop keeps (an
HMAC). A plain hash without a secret is not enough: order numbers are
sequential, so anyone can hash them one by one and find the match. The
same goes for an `order_id` prop.

Most events should omit this third argument entirely.

### From HTML attributes (no JS required)

Tag any clickable element — a click anywhere inside it (even on a
nested icon/span) sends the event:

```html
<button data-genug-on-click="cta_click" data-genug-props='{"plan":"pro"}'>
  Upgrade
</button>
```

`data-genug-props` is optional and must be valid JSON if present;
malformed JSON logs a console warning and sends empty props rather than
breaking the click.

The listener only fires on a real `click` event, so a `<button>` or
`<a href>` works the same for mouse, touch and keyboard (Enter/Space)
activation. Tagging a non-interactive element like a `<div>` instead
works for mouse/touch but never fires for a keyboard-only visitor
unless you've already made it focusable and keyboard-activatable
yourself (`role="button"`, `tabindex`, a keydown handler) — the same
markup that keyboard accessibility requires anyway.

This is also how you track **internal** links. There is no built-in
event for them — define one of your own (see [Defining your own events](#defining-your-own-events))
and tag the links you care about:

```html
<a
  href="/pricing"
  data-genug-on-click="internal_link_click"
  data-genug-props='{"target_url":"/pricing","link_text":"See pricing"}'
>
  See pricing
</a>
```

Internal links are deliberately _not_ covered by
`enableAutoLinkTracking` (which handles outbound links and downloads —
see below). The reason that flag exists is that outbound links and
downloads mostly live inside content you didn't hand-write, so they
can't be tagged. Internal links are your own: you know which ones
matter, and tagging just those keeps the data meaningful instead of
recording every click on every link — which on a content site would
roughly double your stored rows, since each internal click is already
followed by the destination's own `page_view`.

### Tracking page loads

Nothing fires automatically on page load by default. Two ways to opt in
(checked in this order, so a page never fires both):

1. **`data-genug-on-load="event_name"`** (+ optional
   `data-genug-props`) on `<html>` — not `<body>`, since `<html>`
   exists even if the script runs before `<body>` is parsed. Fires that
   named custom event once, at load. Presence alone is the opt-in, same
   as the click attributes above — no config flag needed.
2. **`window.genugAnalyticsConfig.enableAutoPageTracking = true`** — only
   checked if the attribute above isn't present. Fires the built-in
   `page_view` event with `page_title`/`document_language` derived from
   the page automatically.

**Running a single-page app?** Either of these fires once, on the real
page load — a visitor who then browses ten routes is recorded as having
seen one page. You also want `enableAutoRouteTracking`, below.

### Tracking single-page-app route changes

Off by default. Set `enableAutoRouteTracking: true` and every route
change fires a page event too, not just the initial load:

```html
<script>
  window.genugAnalyticsConfig = {
    enableAutoPageTracking: true,
    enableAutoRouteTracking: true,
  };
</script>
```

It's **additive, not a replacement**: it repeats whatever "Tracking page
loads" above is set up to fire, so on its own it sends nothing and warns
in the console. Set `enableAutoPageTracking` alongside it, or put
`data-genug-on-load` on `<html>` — whichever you already use. Either
way the same precedence applies, since a route change runs exactly the
same code a page load does.

What counts as a route change:

- **`history.pushState()`** — what routers call to navigate — and
  **back/forward** (`popstate`), when the path or query string changes.
- **Not `history.replaceState()`.** That means "rewrite the current
  entry" — canonicalising a URL, stripping a token, storing filter state
  — which isn't a visit.
- **Not a hash-only change.** `#faq` → `#pricing` is an in-page jump, so
  counting it would fire a page event for every anchor link and "back to
  top" button. The tradeoff: **hash-routed apps** (`#/about`) aren't
  tracked at all, and since the fragment is stripped before storage,
  calling `track()` for them by hand records only the page they hang
  off. Open an issue if you need them.
- **Not the route you're already on**, however many times a router
  re-pushes it.

The event is fired on the next tick rather than the instant the URL
changes. That's deliberate: frameworks set `document.title` _after_
navigating, so firing immediately would record the previous page's
title, and a route guard redirecting `/old` → `/new` pushes twice in one
tick — waiting records one event, at the URL the visitor actually landed
on.

Note that `document.referrer` doesn't change on a route change; it stays
whichever external site sent the visitor. That's right for attribution,
but it means these events don't record the previous route. The full
`url` is stored on every event, so the sequence is still recoverable
from the raw events.

Why this is a separate flag rather than part of `enableAutoPageTracking`:
plenty of sites use `pushState` for things that aren't navigation — a
lightbox, a wizard step, filter state. Turning this on for everyone
would inflate those deployments' numbers permanently, with nothing on
the stored row to tell a page view that happened from one that didn't.
Missing this flag means you under-count, which you can fix by setting it;
the other direction can't be fixed after the fact.

### Tracking outbound links and downloads

Off by default. Set `enableAutoLinkTracking: true` and every click on a
link leaving your site, or pointing at a downloadable file, is recorded
automatically:

```html
<script>
  window.genugAnalyticsConfig = { enableAutoLinkTracking: true };
</script>
```

- Links to another host fire **`outbound_link_click`** with
  `target_url`, `target_host` and `link_text`.
- Links to a file fire **`file_download`** with `file_url`,
  `file_extension` and `link_text`. A link counts as a file if it has a
  `download` attribute, or its URL ends in a common file extension
  (`.pdf`, `.zip`, `.docx`, …).
- Both URLs are filtered like the page URL: only campaign parameters
  survive, and the `#fragment` is dropped. A signed download link keeps
  its path and loses its signature.

Ask your agent things like _"what are people downloading?"_ or _"where
is my traffic leaving to?"_ — `get_events_by_property` groups either event by
any of its props, e.g. `outbound_link_click` by `target_host`.

Worth knowing:

- **A link that's both wins as a download.** An outbound `.pdf` records
  `file_download`, not `outbound_link_click` — downloading the file is
  what the visitor did; whose server it sat on is incidental.
- **Middle-click is counted**, since "open in new tab" is a normal way
  to follow a link. Right-click (opening the context menu) isn't — it
  isn't a visit.
- **Internal links are not tracked** by this flag; it exists for the
  links you can't hand-tag with `data-genug-on-click`, which in
  practice means outbound and CMS content.
- **File detection is best-effort.** A URL's extension is a hint, not a
  declaration, so a download served from an extensionless URL is only
  caught if the link carries a `download` attribute.
- **Renaming a built-in event needs no client change.** The script never
  sends a name for the three events it fires itself — it sends the role
  (`pageView`, `outboundClick`, `fileDownload`) and the server looks up
  whatever this deployment calls that event. So a rename takes effect
  at once, and a browser holding a cached copy of the script keeps
  working straight through it.

  **Rename it in the cockpit and your existing rows come with it.** The
  Edit button knows the old name and the new one, so it offers to move
  them, ticked by default and showing the count. Rename the _file_
  instead and they stay behind: from the outside, renaming an event and
  deleting one while adding another are the same thing, so nothing can
  tell which old name maps to which new one. The cockpit says the old
  rows are there, and a one-line `UPDATE` you run yourself moves them.
  See "Renaming an event" in
  [recipe-add-event.md](recipe-add-event.md).

  If you **delete** one and leave the flag on, those clicks are rejected
  and show up in the cockpit's rejected counter and in
  `get_top_rejected_events`, saying which tag is missing — the same
  place a mistyped custom event shows up.

- **A tagged link fires only its tag.** If a link carries
  `data-genug-on-click`, the automatic event is skipped, so one click
  is never recorded twice. Same precedence `data-genug-on-load`
  already takes over `enableAutoPageTracking`. A tagged _container_
  around a link is different — an outbound link inside
  `<div data-genug-on-click="card_click">` still fires both, since
  those describe two genuinely different things.

### Limits on what you can send

Generous, and only there to stop one request filling the database:

- The whole request body is capped at **16KB**, which is what bounds
  `props` — they're open by design, so there's no per-prop limit.
- `url` and `referrer` are capped at **2048 characters** each, and `url`
  must be a real absolute `http` or `https` URL. The client script
  always sends `location.href`, so this only matters for a custom
  integration — one sending a `javascript:` or `data:` URL gets a `400`.
- Query parameters other than `utm_*`, `gclid`, `fbclid`, `msclkid`,
  `ttclid`, `ref` and `source` are **stripped** from `url` and
  `referrer`, by the client before sending and again on arrival. Page
  rankings group by path, so nothing you can rank on is lost.
- The **`#fragment` is dropped entirely**, on both sides, for the same
  reason: an OAuth implicit response puts `access_token` there
  precisely to keep it out of server logs, and some reset and
  unsubscribe links do the same. Nothing Genug reports reads a
  fragment. The one thing this costs is hash-routed apps — see the note
  under [route changes](#tracking-single-page-app-route-changes) — whose
  routes now collapse to the page they hang off even if you call
  `track()` for them yourself.
- Event names and `idempotencyKey` are capped at **128 characters**.
- A prop declared as a list holds at most **50 values**, each capped
  like an ordinary prop of its type.

Anything over the body limit gets a `413`; anything failing validation
gets a `400` and shows up in `get_top_rejected_events` with the reason,
so a broken integration is visible rather than silently dropping data.

## Defining your own events

Two ways, and the cockpit is the easier one. Its **Schema registry**
card has a **Register new event** button: name the event, describe it, then add
each prop by picking a type from a list and ticking whether it is
required and whether it holds several values. It is live the moment you
press Create — no restart, no rebuild, nothing to write by hand. The
form never asks you to type a rule string, so the usual way to get one
wrong is not available.

The other way is the file the form writes, and it is worth knowing
either way. One JSON file, named for the event — `order_completed.json`
defines `order_completed`. There is nothing to register, and no
database change is ever needed: every event type shares one table and
type-specific props are stored as JSON rather than as columns.

It goes in **`/data/events/` on your persistent volume**
(`EVENTS_PATH`) — drop the file in, then press **Reload events into system**
in the cockpit's Schema registry card. No restart and no rebuild, so
this works with a stock image straight from a registry. (Restarting the
container does the same thing; the button just saves you the downtime,
and the events that would arrive during it.)

Changing an event you already have is narrower than creating one: the
**Edit** button beside each one covers its name, description and its
props' descriptions and examples. Anything structural on an
event that already exists — adding a prop, changing a type — is a file
edit, because it is already being sent and a changed rule can start
rejecting it.

That directory is the whole registry, not an extension of it. The first
time the server starts against an empty volume it copies the built-in
events (`page_view`, `outbound_link_click`, `file_download`) there and
then leaves the directory alone forever. So the built-ins are yours to
edit too: rename `page_view.json` to `seitenaufruf.json`, reword a
description, delete one you do not want — see "Renaming an event" in
[recipe-add-event.md](recipe-add-event.md) first, because renaming affects data you
have already collected.

Because seeding happens only once, an event you delete stays deleted,
and a file you rename does not come back. The other side of that: if
you build your own image and add an event to
`packages/schema-registry/events/`, it will _not_ appear on a volume
that already has files — put it on the volume as well.

The way back is the cockpit's **Danger zone**, which has a **Reset
events** button: it discards every event file on the volume and copies
the image's built-ins out again. That means the whole directory, not
just the events you added — renaming a built-in is renaming its file,
so there is nothing left to tell a renamed built-in from an event you
wrote, and edits to the built-ins go too. Stored data is not deleted,
which is the part to think about: rows collected under an event name
that no longer exists stay in the database, still counting toward
totals while matching no question asked by name. The button says how
many it stranded, and they are listed in the Schema registry card
afterwards (see "Renaming an event" in [recipe-add-event.md](recipe-add-event.md) for
what to do about them).

Every file is checked at startup. A broken one is skipped and listed in
the cockpit rather than stopping the server, because one typo edited on
a live server must not take collection down for every other event. If
the file carrying `"_pageView": true` is the broken one, the built-in
page-view event stands in for it so page views keep being recorded, and
the cockpit says that is what happened.

```json
{
  "_description": "Fired on the order confirmation page after a successful checkout",

  "order_total": "number",
  "order_total_description": "Order total including tax, in the currency below",
  "order_total_example": 49.9
}
```

**[recipe-add-event.md](recipe-add-event.md)** walks through
it with a full example, and covers the parts that are easy to get
wrong: one prop holds one value, descriptions are what your AI agent
reads to understand your data, and events that would double-count on a
page refresh need an idempotency key.
