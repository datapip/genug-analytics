# Deploying and configuring

Where to put the collector, how to run it, and what every environment variable does.

## The hostname

**Decide the hostname first: the collector must sit on a subdomain of
the site it tracks.** If `your-domain.com` is the tracked site, the
collector belongs at something like `data.your-domain.com` — not on
a different registrable domain, and not on a hosting provider's shared
one (`something.fly.dev`, `something.vercel.app`). The visitor-id cookie
is `SameSite=Lax` and host-only, so it is only sent back when the two
share a registrable domain. Get this wrong and nothing looks broken:
events keep arriving, but every consenting visitor is re-identified from
scratch each day, so consentful mode quietly degrades into the
consentless one. See "Deployment model" in [decisions.md](decisions.md) for why
this is the design rather than a limitation.

**Avoid `analytics.`, `stats.` and `tracking.` as the label**, which is
why the examples here use `data.`. Those are the names ad-blocker filter
lists match on, and a blocked collector fails the same silent way as the
wrong domain — the page still works, the events simply never arrive.
It is the same reasoning that serves the script as `client.js` rather
than `tracker.js`; see "Client script embedding contract" in
[decisions.md](decisions.md).

**Point the record straight at the server, unproxied.** On Cloudflare
that means DNS-only (the grey cloud), not the orange one. A proxied
record resolves to the CDN's edge rather than to your server, which
breaks two separate things:

- **Automatic HTTPS stops being reliable.** Whether the ACME challenge
  behind Caddy or Traefik reaches your server at all depends on the
  zone's SSL/TLS mode and its "Always Use HTTPS" setting, and a zone
  that happens to issue a certificate once can still fail to renew it
  60 days later — at which point the collector goes down rather than
  merely losing its padlock.
- **Every visitor arrives wearing the edge's address.** So all
  consentless visitors collapse into one shared daily identity, and the
  `/events` rate limiter treats your entire audience as a single client.

Proxying it anyway is a supported setup, but it is a deliberate one
with its own requirements — `TRUST_PROXY=2`, an origin nobody can reach
directly, and a specific SSL/TLS mode. A firewall that only admits
Cloudflare's ranges is the usual reason to want it. See
[Deploying on Coolify](#deploying-on-coolify) below, where all three are
spelled out.

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

`DB_PATH` is set explicitly here for local runs (so the file lands in
this directory, not `/data`); it's optional in Docker/Coolify below.

See [Configuration](#configuration) below for what each env var does.

## Installing

Three ways to get a real deployment running, in order of how much they
do for you.

### The install script

The fastest path on a fresh Ubuntu server — it installs Docker, puts
[Caddy](https://caddyserver.com/) in front for automatic HTTPS, and
starts Genug Analytics, asking only for the collector's hostname, the
tracked site's origin, and a cockpit password:

```sh
curl -fsSL https://genug-analytics.com/install.sh | sudo bash
```

It needs root (to install Docker, enable its systemd service, and open
80/443 in `ufw` if one is already active) and a DNS `A`/`AAAA` record
for the hostname already pointing at the server, **unproxied** — on
Cloudflare, DNS-only rather than the orange cloud, or Caddy never gets
its certificate. Or answer `localhost` to try it out first without
either; Caddy then issues itself a self-signed certificate and binds to
`127.0.0.1` instead of the internet.

It checks two things before it does any of that, warning and asking
rather than deciding for you: that the hostname really is a subdomain of
the tracked origin (see [above](#the-hostname)), and that it resolves to
an address this machine actually holds. A proxied record fails the
second check — it resolves to the CDN's edge — but so does a record
pointing at the wrong server, or a box behind NAT, and the script cannot
tell those apart. So it names the proxy as the likely cause rather than
asserting it.

Secrets are generated for you and printed once at the end — copy them
somewhere safe before closing the terminal, they're also saved to
`/opt/genug-analytics/.env`.

**Re-running the script on a box that already has a deployment never
regenerates `MCP_API_KEY`** — doing that would invalidate any MCP
client already configured. It offers to pull the latest image tag in place
instead, leaving the hostname and secrets untouched.

Not on a fresh Ubuntu box, or want more control over what gets
installed? Use one of the two methods below instead.

### Docker Compose on Coolify

Coolify's **Docker Compose** resource type pulls the published image
directly — no git remote or build step, and no need to connect this
repo to Coolify at all. Every pushed `v*` tag is built and published to
`ghcr.io/datapip/genug-analytics` under that tag automatically (see
[releasing.md](releasing.md)):

```yaml
services:
  genug:
    image: "ghcr.io/datapip/genug-analytics:v0.11.0" # the latest released tag
    environment:
      - "ALLOWED_ORIGIN=${ALLOWED_ORIGIN}"
      - "TIMEZONE=${TIMEZONE}"
      - "MCP_API_KEY=${MCP_API_KEY}"
      - "COCKPIT_PASSWORD=${COCKPIT_PASSWORD}"
      # One hop: Coolify's Traefik. Raise to 2 ONLY if this record is
      # also proxied by Cloudflare. Trusting a hop that is not there
      # lets anyone forge the address every rate limit and both
      # password lockouts count — see Configuration below.
      - TRUST_PROXY=1
    volumes:
      - "genug-data:/data"
volumes:
  genug-data: null
```

- **Set the domain**: the **Domains** tab, FQDN e.g.
  `data.your-domain.com` — Coolify's built-in Traefik provisions
  TLS automatically. No `SERVICE_FQDN_*` variable required, that's
  Coolify's own shorthand for generating one, not a requirement.
- **Don't add a `ports:` mapping.** Coolify's Traefik reaches the
  container over its internal network on port 3000, which the image
  already exposes — publishing it to the host too is redundant, and on
  a server running more than one app it can collide with a host port
  something else already holds.
- **No `healthcheck:` needed** — the image already carries one (the
  `Dockerfile`'s `HEALTHCHECK`), and Compose inherits it.
- **`EVENTS_PATH` and `CONTEXT_PATH` need no separate volume**: they
  default to `/data/events` and `/data/context`, both inside the same
  `/data` mount above, and are seeded from the image on first start.
- **Running a demo or other deployment whose MCP key is meant to be
  public?** Add `READ_ONLY=true` — it closes every write (cockpit
  edits, event resets, `delete_visitor_data`) and un-registers
  `get_recent_events`, the one read tool that returns raw rows rather
  than an aggregate. See [Configuration](#configuration).

`TRUST_PROXY` and the Cloudflare proxying question are exactly as
described under [Deploying on Coolify](#deploying-on-coolify) below —
set `2` instead of `1` if this domain is also proxied.

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

**`/data` must be backed by a persistent volume** (the
`-v genug-data:/data` above) — without one, the SQLite file (and
all collected data) is deleted every time the container is redeployed.
`DB_PATH` defaults to `/data/genug.db`, so it doesn't need to be
set explicitly here; only override it if you want the file somewhere
else inside the container.

**If you bind-mount a host directory instead of using a named volume,
chown it first.** The container runs as an unprivileged user (uid 1000),
and a named volume like the one above inherits the right ownership
automatically — but a bind mount keeps whatever the host directory
already has, so a root-owned one isn't writable:

```bash
mkdir -p /srv/genug-data && chown -R 1000:1000 /srv/genug-data
chmod 700 /srv/genug-data
docker run ... -v /srv/genug-data:/data genug
```

If you skip the `chown`, the server refuses to start and tells you
exactly this — it doesn't fail silently or come up half-working.

The `chmod 700` keeps other users on the host out of the database and
its backups. A new directory is usually readable by everyone. Root can
still read it, so a backup job run as root (like the one in
[operations.md](operations.md)) keeps working. If a separate non-root
user copies the backups, give it a group instead:
`chgrp backup /srv/genug-data && chmod 750 /srv/genug-data`. A named
volume needs none of this: Docker keeps those under a folder only root
can open.

**Updating after a code change:** re-run `docker build` — it only
re-runs the layers after your changed files, not the slow dependency-
install layer, so it's fast unless `package.json`/`package-lock.json`
also changed. You only need to edit the `Dockerfile` itself for changes
to the _build process_ (a new workspace package, a Node version bump) —
never for ordinary app code changes.

## Deploying on Coolify

If you'd rather have Coolify build the image itself from this repo on
every deploy — your own fork, say — instead of pulling the published
one (the [Docker Compose method](#docker-compose-on-coolify) above),
Coolify connects to a git remote and does its own `git clone`/`pull` on
its own server each time you deploy — you `git push` like normal, and
either click "Deploy" in its UI or let a push-triggered webhook do it.

1. **Connect the repo** (one-time): Coolify → **Sources** → **Add a
   Source** → GitHub → install the Coolify GitHub App and grant it
   access to this repo.
2. **Create the application**: pick or create a **Project** → **+ New
   Resource** → **Public/Private Repository** → select this repo and
   the `main` branch.
3. **Set the build pack**: Coolify auto-detects the `Dockerfile` at the
   repo root — select **"Dockerfile"**.
4. **Set the exposed port**: in **General**, set **Ports Exposes** to
   `3000` (the internal port `server/index.ts` listens on via `PORT`).
5. **Add environment variables** (see [Configuration](#configuration) below):
   `PORT=3000`, `ALLOWED_ORIGIN=https://<the-tracked-site>`,
   `TIMEZONE=<your zone, e.g. Europe/Berlin>`, plus
   `MCP_API_KEY` and `COCKPIT_PASSWORD`, both toggled as
   **secret**. `DB_PATH` doesn't need to be set — it defaults to
   `/data/genug.db`, matching the volume mount in the next step.
6. **Add persistent storage**: in **Storages**, add a **Volume Mount**
   with container path `/data` — this is what survives redeploys.
7. **Set the domain**: in **Domains**, set the FQDN (e.g.
   `data.your-domain.com`). Coolify's built-in Traefik provisions
   TLS automatically.
8. **Deploy**, and optionally enable the **auto-deploy webhook** in the
   app's Git settings so future pushes redeploy automatically.

The FQDN in step 7 is the one the note at the top of this page
constrains: it has to be a subdomain of the tracked site.

**Set `TRUST_PROXY=1`**, because Coolify's Traefik is one hop in front
of the server. Without it the server sees Traefik's address for every
request instead of the visitor's.

**Keep the collector's DNS record unproxied** — ["The hostname"](#the-hostname)
at the top of this page says why, and the firewall note two paragraphs
down is worth reading before you assume DNS-only will work here. If you
must proxy it, set `TRUST_PROXY=2` rather than `1`, so the address that
gets read is the visitor's and not Cloudflare's.

**`TRUST_PROXY=2` is only safe if the origin cannot be reached
directly.** The number says how many hops to believe, and the server has
no way to check that both were really there. Anyone who connects
straight to the origin then supplies the address themselves, which is
the address every rate limit and both password lockouts count. Restrict
inbound 80/443 to Cloudflare's ranges, or leave the record unproxied and
keep `TRUST_PROXY=1`.

**Check your server's firewall before assuming DNS-only will work.** A
common hardening setup only accepts inbound 80/443 from Cloudflare's own
IP ranges, to stop anyone reaching the origin directly. That's
incompatible with an unproxied record: Let's Encrypt's own validator
doesn't connect from a Cloudflare address either, so the ACME challenge
gets blocked along with everything else, and Traefik is left permanently
serving its self-signed default certificate instead of a real one — a
site that looks unreachable, not just unencrypted. If your server is set
up this way, proxy the record after all (`TRUST_PROXY=2`, as above), and
set Cloudflare's **SSL/TLS mode to Full** — not Flexible, which loops
forever against Traefik's own HTTP→HTTPS redirect, and not Full
(Strict), which needs a certificate on the origin that Cloudflare
trusts, running into the same blocked-ACME problem. Full accepts any
certificate without validating who issued it, which the existing
self-signed one already satisfies — nothing further to configure.

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

The cookie is `Secure`, so the cockpit needs **https** — or `localhost`,
which browsers treat as secure anyway. Over a plain-http LAN address the
browser silently drops the cookie: the password is accepted and the next
request asks you to sign in again. The login page says so when it
happens, rather than leaving it looking like a wrong password.

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

`curl -u` no longer works — the cockpit used to take HTTP Basic Auth and
does not any more.

**If more than one person needs access**, don't share the password: put
`/cockpit` behind your reverse proxy's own authentication (Cloudflare
Access, Authelia, Tailscale, an nginx forward-auth). That gives you real
accounts, MFA and per-person revocation, none of which a single shared
password can. Genug deliberately does not build its own user accounts —
see "Cockpit auth beyond a single shared password" in
[decisions.md](decisions.md).
