# Recipe: change the cockpit

The cockpit is the page at `/cockpit`, behind `COCKPIT_PASSWORD`. It is
mostly numbers to read, plus the Schema registry card, which writes:
reloading, editing and registering events. Six static files, served
exactly as they are on disk:

```
apps/cockpit/index.html    markup
apps/cockpit/cockpit.css   all styling, themed with CSS custom properties
apps/cockpit/cockpit.js    all rendering
apps/cockpit/theme.js      sets the theme before first paint
apps/cockpit/login.html    the sign-in page
apps/cockpit/login.js      posts the password, once
```

The last two, plus `cockpit.css` and `theme.js`, are the only paths
under `/cockpit` reachable without signing in — an exact list in
`server/lib/cockpitAuth.ts`. If the sign-in page comes to need another
file, add it there too, or it will 401.

**There is no build step.** Edit the file, reload the page. Keep it
that way.

## What the cockpit is for

A quick glance answering "is this healthy, and what shape is my
traffic". Anything that needs a follow-up question to interpret —
funnels, segments, custom breakdowns — belongs to the AI agent instead.
That is the product's core split, not a limitation to route around: if
you find yourself building a segment picker, you are rebuilding the
dashboard this tool deliberately doesn't have.

Restyling, rebranding, dropping a widget you don't care about,
translating the labels: all fine, and expected.

## Rules you cannot break

The page ships a Content-Security-Policy (`server/lib/securityHeaders.ts`)
that will silently break these, with no visible error:

- **No external scripts, stylesheets or fonts.** No CDN, no Google
  Fonts, no `<script src="https://...">`. `connect-src` is `'self'`,
  so even a fetch to another host fails.
- **No inline `<script>`.** `script-src` has no `'unsafe-inline'`. Put
  JavaScript in `cockpit.js`. (Inline `style` _attributes_ are allowed,
  and `cockpit.js` uses them for computed values like bar widths.)
- **No framework, no bundler, no npm package.** Plain DOM. If you want
  React here, you want a different app, and `docs/decisions.md`
  explains why that door was closed.
- **The cockpit reads data only from `/cockpit/data`.** Don't call
  `/events` or `/mcp` from this page.
- **Anything that changes server state is a POST or PUT under
  `/cockpit`, and must send `X-Genug-Cockpit: 1`.** That header is half
  the CSRF defence — the session cookie is `SameSite=Lax`, so a browser
  will not send it on a cross-site POST, and a custom header is
  something such a form cannot set either. Two locks that fail
  differently, and a write route needs the header regardless.
  `/cockpit/reload`,
  `POST /cockpit/events` and `PUT /cockpit/events/:name` are the
  existing examples; the two that write a file share one guard
  (`refusesWrite`), which also refuses when the events directory is not
  one the server can write. A router-level check ahead of all of them
  refuses every non-GET request when `READ_ONLY=true`, so a new write
  route is covered without doing anything — as long as it is not a GET.

- **A wrong _confirmation_ password answers 403, never 401.** The two
  danger-zone actions ask for the cockpit password again before they
  run. In this page a 401 means one thing only — the session ran out —
  and `cockpitFetch` acts on it by sending the browser to the login
  page. Answer a mistyped confirmation with one and the owner is thrown
  out of the cockpit over a typo in a form field. 403 is the honest
  code anyway: the request authenticated fine, it reached the handler;
  the retyped confirmation is what failed.
- **Every request the page makes goes through `cockpitFetch`.** It is
  ordinary `fetch` plus the 401 rule above. A call added with bare
  `fetch` still works right up until a session expires, and then reports
  "HTTP 401" in the error banner to someone who only needs to sign in
  again.
- **A write that can strand stored rows logs itself.** Renaming an
  event, deleting one and Reset events call `lib/autoHistory.ts`, which
  adds a dated line to the history log the agent reads before blaming a
  change in the numbers on the website. A new write that can do the same
  belongs there too; one that only changes words does not.
- **A control that re-renders the card has to move focus.** The card is
  rebuilt from scratch, so the button that was clicked no longer exists
  and focus falls to `<body>` — leaving a keyboard user to tab from the
  top of the page back to the form they just opened. Edit, Add a prop,
  Register and Delete each focus their first field; Cancel goes back to
  the row through `reopenEventItem`. Never focus a destructive button:
  one stray Space does the thing.
- **Build form fields with `field(label, control)`.** It pairs the
  label with the control's id, which is what makes clicking the label
  work and stops a screen reader announcing an unlabelled box. A group
  of controls that comes and goes (the example rows) gets an
  `ariaLabel` on each control instead.
- **An open form has to survive a re-render.** Refresh and the period
  buttons rebuild the whole page from server data; `openOrBuildForm`
  hands back the node that is already on screen so typed values are
  not replaced by stored ones. Anything else stateful you add to the
  registry card needs the same treatment.

`cockpit.js` is linted. Any browser global you reach for must be
declared in `eslint.config.js`, so `npm run lint` will tell you.

## Changing how something looks

Colours, spacing and fonts are CSS custom properties defined at the top
of `cockpit.css`, redefined for dark mode. Change them there rather
than hardcoding values in rules, or you will fix light mode and break
dark.

Two conventions worth keeping: colour is used only where it carries
information (the rejected-events count turns red only when nonzero),
and there is no webfont — a privacy tool shouldn't make its own cockpit
fetch a font from someone else's server.

## Adding a widget

Say you want your top products on the page.

**1. Return the data** from `server/routes/cockpit.ts`, inside the
`res.json({ ... })` call — it may use any function from `server/lib/`:

```ts
topProducts: getEventsByProperty(db, "order_completed", "product_id", period, 5)
  .items,
```

**2. Add the markup** in `index.html`, following an existing section.
Give the container an id:

```html
<section class="panel">
  <h2>Top products</h2>
  <div id="top-products"></div>
</section>
```

**3. Render it** in `cockpit.js`. Ranked lists share one component, so
use it rather than writing a table:

```js
function renderTopProducts(topProducts) {
  renderBarList(
    "top-products",
    topProducts,
    (row) => row.value,
    (row) => row.events,
  );
}
```

**4. Call it** from `render(data)`, which is the single dispatcher that
runs after every fetch:

```js
renderTopProducts(data.topProducts);
```

Build helper elements with `el(tag, props, children)` rather than
assigning `innerHTML` — it keeps visitor-supplied strings (URLs, prop
values, page titles) from being parsed as markup.

### A table has to survive a phone

Two rules, both learned by breaking them:

- **Wrap it in `.table-wrap`** (which scrolls) _and_ make sure nothing
  between it and the page can refuse to shrink. `.stack` is a column
  flex container, so its children get `min-width: 0` — without that a
  card cannot go narrower than its table's `min-width: 460px`, the
  wrapper never gets narrower than its table either, and `overflow-x`
  has nothing to clip: the whole page scrolls sideways instead.
- **Sideways scroll is only acceptable for columns nobody needs.** If a
  column carries the point of the table, it cannot sit off the right
  edge behind a scrollbar a phone does not draw. Stack the rows into
  blocks at `max-width: 780px` instead — hide `thead`, make the rows
  and cells `display: block` — as the rejected-events and schema
  registry tables do. Scope those rules the way the block rule is
  scoped, or an id selector will outrank a bare class and cells you
  meant to sit inline will not.

### A list of reference material is a list of accordions

The Schema registry and the MCP tool list are both a column of closed
`<details>`, and anything similar should be too. The rule they share:
the closed row carries the name and whatever is worth knowing without
opening it (prop counts, stored-row counts), never the description. A
description truncated to fit competes with the names, which is the one
thing a closed list exists to let you read down.

Put controls in the opened body, not in the `<summary>` — a button
inside a summary is a control inside a control, and clicking it toggles
the accordion too. If a control re-renders the list, remember focus:
the element it was on no longer exists, and a button inside a collapsed
`<details>` cannot take focus at all.

### Distinguish "no data" from "not configured"

An empty chart that means "you configured this wrong" and one that means
"quiet week" look identical, and only one of them needs fixing. So if a
widget depends on something a deployment can genuinely leave out, say
which case it is on screen rather than rendering the same empty state
for both.

The page-view event is not such a case: exactly one registered event
always carries the `pageView` tag, so every page-scoped widget gets an
array and an empty one honestly means no traffic. `renderBarList`
therefore takes rows, never `null`.

## Changing the period options

The picker offers 24h / 7d / 30d, validated server-side in
`parseWindowDays` (`server/routes/cockpit.ts`) — an unlisted value
falls back to the default rather than being honoured. To change the
options, edit `ALLOWED_WINDOW_DAYS` _and_ the buttons in `index.html`.

A free-form date range is deliberately not offered: that is analysis,
which is the agent's job.

## Verify

```sh
npm run build && npm run lint && npm run format:check
```

Then load `/cockpit` and check both themes — the toggle is in the
header, and dark mode is where a hardcoded colour shows up. Open the
browser console: a CSP violation is reported there and nowhere else.
