# Getting started

The short path from nothing to your first question. Each step links to
the details.

**On a fresh Ubuntu server, one command does steps 1–4:** it asks for
the hostname, the tracked site's origin and a password, generates the MCP key, and puts Caddy in
front for HTTPS. Point the DNS record at the server first (step 1).

```sh
curl -fsSL https://genug-analytics.com/install.sh | sudo bash
```

Save the key and password it prints, then go to [step 5](#5-put-the-script-on-your-site).
On Coolify or anything else, see [installing](deploying.md#installing).

## 1. Pick a hostname

Use a **subdomain of the site you track**, such as
`data.your-domain.com`. Add an `A` record for it pointing at your
server, **unproxied** (DNS-only on Cloudflare). Give it a few minutes.
→ [The hostname](deploying.md#the-hostname)

## 2. Generate your secrets

Run this twice, once for `MCP_API_KEY` and once for
`COCKPIT_PASSWORD`, and keep both in a password manager:

```sh
openssl rand -hex 32
```

## 3. Run it

On a server with Docker, keeping `/data` on a volume:

```sh
docker run --rm -d --name genug -p 127.0.0.1:3000:3000 \
  -e ALLOWED_ORIGIN=https://your-tracked-site.com \
  -e TIMEZONE=Europe/Berlin \
  -e MCP_API_KEY=<first-secret> \
  -e COCKPIT_PASSWORD=<second-secret> \
  -e TRUST_PROXY=1 \
  -v genug-data:/data \
  ghcr.io/datapip/genug-analytics:v0.11.0
```

It listens only on the machine itself; step 4 puts HTTPS in front.
`TRUST_PROXY=1` tells it there is one proxy.
→ [Configuration](deploying.md#configuration)

## 4. Put a reverse proxy in front of it

[Install Caddy](https://caddyserver.com/docs/install), put this in
`/etc/caddy/Caddyfile`, and run `sudo systemctl reload caddy`:

```
data.your-domain.com {
    reverse_proxy localhost:3000
}
```

Caddy gets the certificate itself, once the DNS record resolves and
ports 80/443 are open.

## 5. Put the script on your site

Early in `<head>`:

```html
<script>
  window.genugAnalyticsConfig = { enableAutoPageTracking: true };
</script>
<script defer src="https://data.your-domain.com/client.js"></script>
```

→ [Embedding the client script](client.md#embedding-the-client-script),
[Tracking events](client.md#tracking-events) for clicks, downloads
and your own events

## 6. Watch the first event arrive

Open `https://data.your-domain.com/cockpit` and sign in with
`COCKPIT_PASSWORD`. Load a page on your site, and it shows up under
**Recent events**. If it doesn't:

- The **Rejected** count says why the server refused it.
- A CORS error in the browser console means the site isn't in
  `ALLOWED_ORIGIN`.
- If sign-in keeps asking again, you're on plain HTTP. Use the
  `https://` address.

## 7. Connect an AI agent

For Claude Code it is one line; other clients are in [mcp.md](mcp.md):

```sh
claude mcp add --transport http genug https://data.your-domain.com/mcp \
  --header "Authorization: Bearer YOUR_MCP_API_KEY"
```

Then ask: _"What were my top pages this week, and where did that
traffic come from?"_

## Before you go live

Three things the software can't decide for you:

- **Your privacy notice.** What Genug stores, and a template.
  → [Privacy](privacy.md)
- **Your retention period.** `RETENTION_DAYS` defaults to 396 days (13
  months). → [Retention](operations.md#retention)
- **Whether you need a consent banner.** Genug works without one, but
  whether that is allowed for your site is a question for your lawyer.
  → [Questions for your lawyer](privacy.md#questions-for-your-lawyer)

## Next

- [Make it yours](../README.md#make-it-yours) — the three recipes for
  adding events, adding MCP tools and changing the cockpit.
