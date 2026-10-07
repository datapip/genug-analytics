# Deploying and configuring

Where to put the collector, how to run it, and what every environment variable does.

## The hostname

**Put the collector on a subdomain of the site it tracks**, such as
`data.your-domain.com` for `your-domain.com`. Not on another domain,
and not on a shared one like `something.fly.dev`. The consent cookie is
only sent back when both share a domain. Get this wrong and nothing
looks broken, but consenting visitors are counted as new every day.

**Avoid `analytics.`, `stats.` and `tracking.`** as the label. Ad
blockers match those names, and a blocked collector fails just as
silently.

**Point the DNS record straight at the server.** On Cloudflare, that
means DNS-only (grey cloud), not proxied (orange). A proxied record
breaks two things:

- **HTTPS certificates** may not be issued, or may fail to renew 60 days
  later and take the collector down.
- **Every visitor arrives from Cloudflare's address**, so all
  consentless visitors merge into one, and the rate limiter treats your
  whole audience as one client.

### If you must proxy through Cloudflare

The usual reason is a firewall that only lets in Cloudflare's address
ranges. That firewall also blocks the certificate check, so DNS-only
won't work there. Proxying is supported, with three settings:

- `TRUST_PROXY=2` (Cloudflare plus your own proxy).
- **Nobody may reach the origin directly**: allow inbound 80/443 only
  from Cloudflare. Otherwise anyone can fake the address every rate
  limit and password lockout counts.
- Cloudflare's **SSL/TLS mode set to Full**. Flexible loops forever
  against the proxy's HTTPS redirect, and Full (Strict) needs a
  certificate the blocked check can't get.

## Build and run locally

```sh
npm install
npm run build
DB_PATH=./genug.db \
ALLOWED_ORIGIN=https://your-tracked-site.com \
TIMEZONE=Europe/Berlin \
MCP_API_KEY=<random-secret> \
COCKPIT_PASSWORD=<random-secret> \
node server/dist/index.js
```

`DB_PATH` puts the file in this folder instead of `/data`. See
[Configuration](#configuration) for every variable.

## Installing

Three ways, from the one that does the most for you.

### The install script

On a fresh Ubuntu server, this installs Docker, puts
[Caddy](https://caddyserver.com/) in front for HTTPS, and starts Genug.
It asks for the hostname, the tracked site's origin and a cockpit
password:

```sh
curl -fsSL https://genug-analytics.com/install.sh | sudo bash
```

It needs root (it installs Docker and opens 80/443 in `ufw` if that is
active) and a DNS record already pointing at the server,
unproxied ([above](#the-hostname)). Answer `localhost` to try it
without either. Before installing, it checks that the hostname is a
subdomain of the tracked site and resolves to this machine, and asks
you if not.

The secrets are printed once at the end and saved to
`/opt/genug-analytics/.env`. Running the script again offers to update
in place and never changes `MCP_API_KEY`, so your agents keep working.

### Docker Compose on Coolify

Coolify's **Docker Compose** resource pulls the published image; you
don't need to connect this repo. Every release is published to
`ghcr.io/datapip/genug-analytics` ([releasing.md](releasing.md)):

```yaml
services:
  genug:
    image: "ghcr.io/datapip/genug-analytics:v0.11.0" # the latest released tag
    environment:
      - "ALLOWED_ORIGIN=${ALLOWED_ORIGIN}"
      - "TIMEZONE=${TIMEZONE}"
      - "MCP_API_KEY=${MCP_API_KEY}"
      - "COCKPIT_PASSWORD=${COCKPIT_PASSWORD}"
      # One hop: Coolify's Traefik. Use 2 only if Cloudflare proxies
      # this record too — see "If you must proxy through Cloudflare".
      - TRUST_PROXY=1
    volumes:
      - "genug-data:/data"
volumes:
  genug-data: null
```

- Set the domain in the **Domains** tab, e.g. `data.your-domain.com`.
  Coolify handles HTTPS.
- Don't add `ports:` or a `healthcheck:`. Traefik reaches port 3000
  internally, and the image has its own health check.
- Events and context live inside the same `/data` volume.

### Build and run with Docker

```sh
docker build -t genug .
docker run --rm -p 3000:3000 \
  -e ALLOWED_ORIGIN=https://your-tracked-site.com \
  -e TIMEZONE=Europe/Berlin \
  -e MCP_API_KEY=<random-secret> \
  -e COCKPIT_PASSWORD=<random-secret> \
  -v genug-data:/data \
  genug
```

**`/data` must be a persistent volume**, or every redeploy deletes your
data.

**A bind mount needs the right owner.** The container runs as uid 1000,
and a named volume sets that up by itself. A host folder doesn't:

```bash
mkdir -p /srv/genug-data && chown -R 1000:1000 /srv/genug-data
chmod 700 /srv/genug-data
docker run ... -v /srv/genug-data:/data genug
```

Without the `chown`, the server refuses to start and says why. The
`chmod 700` keeps other users on the host out; a backup job running as
root still works. If a non-root user copies the backups, use a group
instead: `chgrp backup /srv/genug-data && chmod 750 /srv/genug-data`.

After changing code, run `docker build` again.

## Deploying on Coolify

To have Coolify build from your own fork on every push, instead of
pulling the published image:

1. **Connect the repo:** Coolify → **Sources** → **Add a Source** →
   GitHub, and give the Coolify GitHub App access to the repo.
2. **Create the application:** a **Project** → **+ New Resource** →
   **Public/Private Repository**, then the repo and the `main` branch.
3. **Build pack:** **Dockerfile**.
4. **Port:** in **General**, set **Ports Exposes** to `3000`.
5. **Environment variables:** `ALLOWED_ORIGIN`, `TIMEZONE`,
   `TRUST_PROXY=1`, and `MCP_API_KEY` and `COCKPIT_PASSWORD` marked as
   **secret**.
6. **Storage:** in **Storages**, add a **Volume Mount** at `/data`.
7. **Domain:** in **Domains**, a subdomain of the tracked site
   ([the hostname](#the-hostname)). Coolify handles HTTPS.
8. **Deploy.** Turn on the auto-deploy webhook if you want pushes to
   deploy.

## Configuration

Copy `.env.example` to `.env` and fill it in — it lists everything below,
including the `openssl rand -hex 32` commands for the three secrets. The
server refuses to start if any required variable is missing, rather than
coming up in an insecure state.

| Env var             | Required                      | Purpose                                                                          |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| `ALLOWED_ORIGIN`    | yes                           | The tracked site's exact origin, e.g. `https://example.com`. Comma-separated.    |
| `TIMEZONE`          | yes                           | The time zone reports are in, as an IANA name like `Europe/Berlin`. See below.   |
| `MCP_API_KEY`       | yes                           | The key your AI agent sends as `Authorization: Bearer …`.                        |
| `COCKPIT_PASSWORD`  | yes                           | The password for `/cockpit`. See below.                                          |
| `PORT`              | no (default `3000`)           | The port the server listens on.                                                  |
| `DB_PATH`           | no (default `/data/genug.db`) | The SQLite file.                                                                 |
| `TRUST_PROXY`       | no (default `0`)              | How many reverse proxies sit in front. See below.                                |
| `EVENTS_PATH`       | no (default `/data/events`)   | Your event definitions ([defining events](client.md#defining-your-own-events)).  |
| `CONTEXT_PATH`      | no (default `/data/context`)  | What your agent reads before answering ([mcp.md](mcp.md)).                       |
| `RETENTION_DAYS`    | no (default `396`)            | Days of data kept; `-1` keeps everything ([retention](operations.md#retention)). |
| `KEPT_QUERY_PARAMS` | no (default the six `utm_*`)  | Query parameters kept on stored URLs. See below.                                 |
| `KEPT_HASH_VALUES`  | no (default none)             | `#fragments` kept on stored URLs, e.g. `pricing,faq`. `*` keeps all.             |
| `LOCAL_BACKUPS`     | no (default `true`)           | A daily backup beside the database, 7 days kept.                                 |
| `UPDATE_CHECK`      | no (default `true`)           | Asks GitHub once a day whether a newer version exists. Sends no data.            |
| `READ_ONLY`         | no (default `false`)          | Turns off every write, for a deployment whose MCP key is public. See below.      |

**`TIMEZONE`** sets where a day and an hour begin, everywhere: the
cockpit, every by-day and by-hour tool, and what a bare date means. It
also sets when the daily salt is replaced. Find your zone in the "TZ
identifier" column of [Wikipedia's list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
A fixed offset such as `+01:00` is refused, because it is wrong for
half the year. Genug ignores the container's `TZ`.

**`COCKPIT_PASSWORD`** is exchanged for a session cookie lasting 12
hours. Changing it signs out every browser. The cockpit can read and
edit the agent's context files, so treat this password like the MCP
key.

**`TRUST_PROXY`** is `1` behind one proxy (Traefik, nginx, Caddy) and
`2` behind that plus Cloudflare. Leave it unset when the port is
published directly. **Never set it higher than the proxies you
actually have**: anyone could then fake the address every rate limit
counts, including the cockpit's password lockout.

**`KEPT_QUERY_PARAMS`** takes exact names, comma-separated. `utm_*` is
refused, since it would also keep `utm_email=`. `*` keeps everything,
emails and tokens included. Changes reach browsers within an hour and
apply to URLs stored from then on. The privacy template names the
defaults, so update it if you add any ([privacy](privacy.md#what-gets-stored)).

**`READ_ONLY=true`** removes `delete_visitor_data`, `add_history_note`
and `get_recent_events`, and the cockpit refuses every edit. Collection
continues. Use it for a demo or any deployment whose key is public;
the context files are then public too.

## Signing in to the cockpit

`/cockpit` sends you to a sign-in page. Type `COCKPIT_PASSWORD` once and
the server sets a session cookie that lasts 12 hours; **Log out** in the
header clears it. Changing `COCKPIT_PASSWORD` and redeploying signs out
every browser, which is the way to revoke access if the password has
been somewhere it shouldn't.

The cookie is `Secure`, so the cockpit needs **https** or `localhost`.
Over plain http on a LAN address, the browser drops the cookie and asks
you to sign in again. The sign-in page says so when it happens.

**From a script or a terminal**, sign in first and keep the cookie:

```sh
curl -s -c genug-cookies.txt -X POST https://data.your-domain.com/cockpit/session \
  -H 'content-type: application/json' -H 'x-genug-cockpit: 1' \
  -d '{"password":"<COCKPIT_PASSWORD>"}'

curl -s -b genug-cookies.txt 'https://data.your-domain.com/cockpit/data?range=7d'
```

`range` is one of `today`, `24h`, `7d` or `30d`, the same as the
cockpit's buttons, and defaults to `7d`. `today` and `24h` end now.
`7d` and `30d` are complete days in `TIMEZONE` and leave out today. Any other
value, or the old `days` parameter, gets a 400 naming the valid ones.

**If more than one person needs access**, don't share the password. Put
`/cockpit` behind your proxy's own sign-in (Cloudflare Access, Authelia,
Tailscale, nginx forward-auth) for real accounts and two-factor login.
Genug has no user accounts of its own.
