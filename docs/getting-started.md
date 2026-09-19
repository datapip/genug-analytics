# Getting started

The short path from nothing to asking your first question. Every step
links to the page that has the details; this one has none of its own.

![The Genug Analytics cockpit: an Overview band with session, event, rejected and bot counts, then a traffic trend chart and cards ranking top pages, top referrers and device types](assets/cockpit.png)

## 1. Pick a hostname

The collector has to live on a **subdomain of the site it tracks**:
`analytics.your-domain.com` for `your-domain.com`. Not a different
domain, not a hosting provider's shared one. Get this wrong and nothing
looks broken, but consenting visitors are forgotten every day.
→ [The hostname](deploying.md#the-hostname)

## 2. Run it

Three secrets and one origin, nothing else required. For a first look on
your own machine:

```sh
npm install
npm run build
DB_PATH=./genug.db \
ALLOWED_ORIGIN=https://your-tracked-site.com \
SALT_SECRET=<random-secret> \
MCP_API_KEY=<random-secret> \
COCKPIT_PASSWORD=<random-secret> \
node server/dist/index.js
```

For a real deployment use the Docker image, with `/data` on a
persistent volume so the database survives a redeploy.
→ [Build and run with Docker](deploying.md#build-and-run-with-docker),
[Deploying on Coolify](deploying.md#deploying-on-coolify),
[Configuration](deploying.md#configuration) for what each variable does

## 3. Put the script on your site

Early in `<head>`. Nothing fires on its own until you turn page
tracking on, which is what the config object does:

```html
<script>
  window.genugAnalyticsConfig = { enableAutoPageTracking: true };
</script>
<script defer src="https://analytics.your-domain.com/client.js"></script>
```

→ [Embedding the client script](client.md#embedding-the-client-script),
[Tracking events](client.md#tracking-events) for clicks, downloads
and your own events

## 4. Watch the first event arrive

Open `https://analytics.your-domain.com/cockpit` with the
`COCKPIT_PASSWORD` you set (any username). Load a page on your site and
it shows up under **Recent events**. If it doesn't, the **Rejected**
count in the top strip says why, and an origin that isn't in
`ALLOWED_ORIGIN` fails in the browser console, never on the server.

## 5. Connect an AI agent

Point any MCP client at `/mcp` with the `MCP_API_KEY`. For Claude Code
it is one line:

```sh
claude mcp add --transport http genug https://analytics.your-domain.com/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

Then ask it: _"What were my top pages this week, and where did that
traffic come from?"_
→ [Connecting an AI agent](mcp.md), including what you can ask and
what leaves your server when you do

## Before you go live

Two things the software cannot do for you:

- **Say what you collect** in your privacy notice, and name a legal
  basis. The field table and the checklist are written for exactly
  this. → [Running without a consent banner](privacy.md#running-without-a-consent-banner)
- **Say how long you keep it, if 425 days isn't right.** `RETENTION_DAYS`
  defaults to 425 days; set it if you want a different period, or `-1`
  to keep everything. Your notice should say which. → [Retention](operations.md#retention)

## Next

- [Make it yours](../README.md#make-it-yours) — the three recipes for
  adding events, adding MCP tools and changing the cockpit.
