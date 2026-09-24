# Manual end-to-end testing

This walks through verifying the whole pipeline — client script →
collector → cockpit/MCP — against a second, ordinary local website, so you can see
it work the way a real deployment would (two different origins, a real
browser, real navigation) rather than just `curl`. See [deploying.md](deploying.md) and
[client.md](client.md) for setup and usage, and [decisions.md](decisions.md)
for the full architecture and decisions.

The worked example below uses a local Astro site, but any local dev
server works the same way — the only thing that matters is that it runs
on a different origin than genug.

## 1. Build everything

```sh
npm install
npm run build
```

This builds `schema-registry`, `client`, and `server` in that order —
the root `build` script runs each workspace package's own `build`
script explicitly, in dependency order (`server` imports
`schema-registry`'s compiled output, so it has to build second).

## 2. Start the other site first, and note its real origin

```sh
npm run dev    # or whatever that project uses
```

**Read the origin it actually prints** — don't assume a framework's
default port. Astro's default dev port is `4321`, but if that port is
already taken it silently picks another one (`3000`, `3001`, ...), and
you might just be running a different project than last time anyway.
Whatever it says (`http://localhost:XXXX`), that's the exact value
`ALLOWED_ORIGIN` needs in the next step — scheme + host + port, no
trailing slash, no path.

## 3. Start the genug server

```sh
DB_PATH=./dev.db \
ALLOWED_ORIGIN=http://localhost:XXXX \
MCP_API_KEY=dev-mcp-key \
COCKPIT_PASSWORD=dev-cockpit-password \
PORT=3001 \
node server/dist/index.js
```

- `ALLOWED_ORIGIN` — the exact origin from step 2. A mismatch here
  doesn't error loudly; the browser just blocks the client script's
  request with a CORS error ("No 'Access-Control-Allow-Origin' header"),
  which looks like a bug but is really just this value being wrong.
- `PORT` just needs to not collide with the other site's dev server.
- `./dev.db` is already covered by `.gitignore` (`*.db*`), so it's safe
  to leave lying around at the repo root.
- `EVENTS_PATH` is deliberately left unset. In a container the server
  seeds `/data/events` from the image and reads only that; on a machine
  with no `/data` it skips seeding and reads the repo's
  `packages/schema-registry/events/` instead, so editing those files
  and restarting works the way it always has. The cockpit will show one
  schema error saying `/data/events` was not created — expected here,
  and the same line would mean a missing volume mount in production.

## 4. Point the other site's client script at it

Add the config object and script tag to the other site, as early in
`<head>` as convenient:

```html
<script>
  window.genugAnalyticsConfig = { enableAutoPageTracking: true };
</script>
<script defer src="http://localhost:3001/client.js"></script>
```

`enableAutoPageTracking` defaults to `false` — without setting it here,
the client script sends nothing on its own (see "Tracking page loads"
in [client.md](client.md)).

For an Astro site specifically, that's in `src/layouts/Base.astro`,
right before `</head>`. **This is a temporary edit for local testing
only** — revert it afterward rather than committing it to that repo.
Most dev servers hot-reload on save, so the already-running site should
pick this up without a restart.

## 5. Watch it happen

Open the other site in a browser with devtools open (Network tab). On
page load you should see:

- A request to `http://localhost:3001/client.js` — `200`.
- A request to `http://localhost:3001/events` — `204`, no body. This is
  the automatic `page_view` event (see `packages/client`).

Navigate to another page on the same site (or run
`window.genugAnalytics.track("outbound_link_click", { target_url: "https://example.com/x", target_host: "example.com", link_text: "x" })`
in the console) to generate a second event. `consent` was never set, and
there's no cookie yet either, so no cookie gets set now — this is the
consentless path, identified by a per-day salted hash of IP +
User-Agent (see "Visitor identification" in `docs/decisions.md`).
Repeated loads within 30 minutes count as the same session.

### Exercising the `data-genug-on-click` path

The three shipped events are the ones the client fires on its own. To
test the **hand-tagged** path — `data-genug-on-click` on a clickable
element, which is how a deployment tracks anything the client doesn't
know about — you need an event to tag links with, and there is no
built-in one for that.

The quickest way is the cockpit: **Register new event** in the Schema
registry card, with two text props (`target_url`, `link_text`). That
exercises the create form at the same time. The file it writes is the
one below, and writing it by hand does the same job — in whichever
directory the server is reading, `packages/schema-registry/events/`
when running from a clone as above, `EVENTS_PATH` otherwise:

```json
// internal_link_click.json
{
  "_description": "Fired when a visitor clicks a link that stays on this site",

  "target_url": "string.long",
  "target_url_description": "URL the link points to",
  "target_url_example": "/pricing",

  "link_text": "string",
  "link_text_description": "Visible text of the clicked link",
  "link_text_example": "Pricing"
}
```

Press **Reload events into system** in the cockpit's Schema registry card so
the server picks the file up (restarting works too), then tag a link on
the other site:

```html
<a
  href="/pricing"
  data-genug-on-click="internal_link_click"
  data-genug-props='{"target_url":"/pricing","link_text":"See pricing"}'
>
  See pricing
</a>
```

Clicking it should produce a `204` to `/events`, and the event should
appear in the cockpit under its own name. Nothing about this path is
specific to that event — the client sends whatever name the attribute
carries — so it equally tests `cta_click`, `newsletter_signup` or
anything else you define.

Delete the file again afterwards if you don't want it registered. (The
cockpit deletes nothing — removing an event is a file operation, then
**Reload events into system**.)

## 6. Confirm it landed

Open `http://localhost:3001/cockpit/` — it sends you to a sign-in page
asking for `COCKPIT_PASSWORD` from step 3. (Use `localhost`, not your
machine's LAN address: the session cookie is `Secure`, and a browser
only treats localhost as a secure context over plain http.) The events
should show up
under "Recent events" and the summary numbers should reflect them. This
also exercises `routes/cockpit.ts` and the `lib/` query modules it
calls for real, not just against seeded test data.

Worth a look while you are here: open the Schema registry card and
press **Edit** on the event you tagged links with. Rename it and save —
the form offers to carry the stored events across, and the events you
fired a minute ago move with it. Then rename it back.

To exercise the MCP side too, point an MCP client at
`http://localhost:3001/mcp` with `Authorization: Bearer dev-mcp-key` and
call `get_traffic_summary`, `get_top_pages`, or `list_event_types`, or
read the `genug://schema-registry` resource.

## 7. Clean up

- Remove the temporary `<script>` tag from the other site.
- Stop both dev servers.
- Delete `./dev.db` (and its `-wal`/`-shm` siblings) if you don't want
  to keep the test data around.
