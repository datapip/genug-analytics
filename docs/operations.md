# Operating a deployment

How much traffic it takes, retention, opt-out and erasure, backups and restore, and the one kind of change that needs a database migration.

## How much traffic it handles

Measured, not estimated — `scripts/load-events.mjs` against a real
server, checking the rows actually landed. Re-run it rather than trust
these numbers on hardware unlike the one below.

**Collecting** holds at about **2,900 events a second**, sustained, with
the median request taking 1.5 ms and 95% under 14 ms. That did not
change between a 250,000-row database and a 5,000,000-row one: an insert
costs what it costs. For scale, a site doing a million page views a day
averages twelve a second, so the headroom is for spikes, not for the
average.

Two things cap it before the server does. One address may send 600
events a minute (see `lib/rateLimit.ts`), so this throughput assumes
what it looks like in practice — many visitors, a handful of events
each. And writes are synchronous, so a single Node process is the
ceiling: concurrency past about four buys latency, not throughput.

**Storage** runs about **0.4 KB per event** including indexes — a
million events is roughly 350 MB. Long URLs and big `props` move that.

**Reading** is where size shows. The cockpit's own page, at a 7-day
window:

| Events stored | Database | Cockpit page |
| ------------- | -------- | ------------ |
| 100,000       | 35 MB    | 21 ms        |
| 250,000       | 88 MB    | 45 ms        |
| 500,000       | 176 MB   | 99 ms        |
| 1,000,000     | 356 MB   | 220 ms       |
| 2,500,000     | 899 MB   | 559 ms       |
| 5,000,000     | 1.8 GB   | 1.2 s        |

It still grows with the table rather than with the week on screen, and
about two thirds of the 5-million figure is now two panels that
genuinely read all of history: how many events are stored per type, and
the check for events stranded by a rename. The rest of the page is
bounded by the period. Switching the cockpit to its 30-day window on
that database costs 2.9 s, because that window really is more rows.

Questions asked through the agent vary by the shape of the question
rather than the size of the answer, at 5,000,000 events: `get_top_pages`
over 30 days 0.17 s, `get_events_by_property` 0.07 s, `get_steps_funnel`
0.3 s, a segmented `get_top_referrers` 1.1 s, and `get_traffic_summary`
0.19 s over 30 days but 3.3 s over a year. Asking for a **year** is the
expensive shape — `get_traffic_by_day` over one takes 5 s — and it is
expensive for a plain reason: a year of a five-million-event database is
the database. `get_recent_events` is instant whatever the size.

If you are past a couple of million events and only ever ask about
recent weeks, `RETENTION_DAYS` is the lever that costs nothing: the page
time above follows the rows in the table, not the rows you look at.

### Does it need a big server?

No. Everything that costs time here runs on **one core**: an event is one
synchronous insert, a cockpit panel one synchronous query. Re-measured
with the server confined by CPU affinity and a memory cgroup, against an
identical one-million-event database each time:

| Server limited to | Events/second | Cockpit, 7 days | Cockpit, 30 days | Peak memory |
| ----------------- | ------------- | --------------- | ---------------- | ----------- |
| 1 CPU, 4 GB       | 2,870         | 0.30 s          | 0.48 s           | 281 MB      |
| 2 CPUs, 4 GB      | 2,987         | 0.26 s          | 0.49 s           | 252 MB      |
| unconstrained     | 2,972         | 0.27 s          | 0.49 s           | 249 MB      |

The second core buys about 4% on the write path and nothing on the read
path; cores after it buy nothing at all.

Those are a bare `node` process, though, and that is not how this
deploys. The real thing is a container, usually behind a reverse proxy
terminating TLS — and on a 2 vCPU box all of that shares the same two
cores. Same database, same cap, everything pinned to the same two CPUs:

| Running as                | Events/second | Cockpit, 7 days | Cockpit, 30 days |
| ------------------------- | ------------- | --------------- | ---------------- |
| bare process              | 2,987         | 0.26 s          | 0.49 s           |
| in Docker                 | 2,805         | 0.22 s          | 0.51 s           |
| in Docker, proxy in front | 2,276         | 0.23 s          | 0.50 s           |

The container costs about 6% of the ingest rate and the proxy hop
another 18%. Reading is untouched — one more hop is a millisecond on a
page that takes a fifth of a second. So **2 vCPUs and 4 GB is enough**,
with the stack included: 2,276 events a second is still about 190 times
what a site doing a million page views a day averages.

Memory is not the constraint either, though the container is not the
whole bill. Under sustained load the app container held 215 MB, the
proxy 15 MB, and Docker's own `dockerd` and `containerd` about 200 MB
between them — roughly **430 MB** before the operating system's own
needs. Genug itself stays around 250 MB whatever it is doing, because
SQLite reads through the page cache rather than holding the table; that
is what the remaining ~3.5 GB of a 4 GB box is doing, and while the
database fits in it, reads never touch the disk. A five-million-event
database is 1.8 GB, so 4 GB holds one with room left.

**The floor is a lot lower than 4 GB**, if you are pricing a cheap tier.
The same one-million-event database ran at full speed with the container
limited to 512 MB, and still served it — 2,827 events a second, no
out-of-memory kill — at 128 MB. Node sizes its heap to the limit it is
given, and SQLite reads through the page cache rather than loading the
table, so there is no fixed working set that has to fit. What sets the
minimum is everything _around_ Genug: a minimal Linux (~200 MB),
Docker's daemons (~200 MB) and a proxy (~15 MB), so the box commits
roughly 600–700 MB before Genug asks for anything. **1 GB works, 2 GB is
comfortable**, and 4 GB is headroom rather than a requirement — what the
headroom buys is page cache, so more of a growing database stays in RAM
instead of being read back from disk.

If you have seen Docker quote a 4 GB minimum, that is **Docker
Desktop**, which runs a Linux VM on macOS and Windows. Docker Engine on
a Linux VPS is a daemon, and the ~200 MB above is what it actually cost
here.

One honest limit on those small-memory figures: they cap the
_container_, on a host with 24 GB, so the operating system's page cache
still held the database behind them. A real 1 GB machine has no such
cushion, and reads there will go to disk sooner than these numbers
suggest. The write path is unaffected either way — it is bounded by how
fast a commit lands, not by how much is cached.

What this does **not** vary is how fast a core is or how fast the disk
commits, which is exactly what a VPS changes: a vCPU is a share of a
server core, and network-attached storage is slower to flush than the
NVMe below. Writes here are synchronous — every event waits for its
commit to land — so the disk is the one thing that can really cut the
ingest figure. Two further gaps: the proxy above spoke plain HTTP, so
TLS is not in these numbers (cheap per request on a keep-alive
connection, not free when a burst of new visitors each need a
handshake), and if you run **Coolify on the same box**, its own
Postgres, Redis and Traefik want several hundred MB of that 4 GB before
Genug starts — budget for it, or give Genug its own machine. Treat these
as an upper bound, and run `scripts/load-events.mjs` on the box you
actually bought.

Measured on an AMD Ryzen 7 PRO 7840U laptop (8 cores), 24 GB RAM, NVMe
SSD, ext4, Node 24, client and server on the same machine. A small cloud
VPS with shared vCPUs and network-attached storage will do less,
especially on the write path, which is bounded by how fast a small
transaction reaches disk.

## Data lifecycle

- **Opting out**: `genugAnalytics.optOut()` writes a first-party
  `genug_optout` flag, after which the script sends nothing at all for
  that browser until `optIn()` is called. It makes exactly one request
  on the way out — no event, no URL — so the server can clear the
  `genug_vid` cookie the page cannot delete itself; that request is
  never stored, and nothing is counted or recorded about it. This is
  the Art. 21 objection route a deployment relying on legitimate
  interest needs — link it from your privacy notice.
- **Bot filtering**: requests to `/events` whose `User-Agent` matches a
  known crawler/automation-tool signature (or has no `User-Agent` at
  all) are silently dropped — no error, no stored row, same response as
  a real event. This is best-effort: it catches bots that identify
  themselves honestly (most crawlers do), not one deliberately spoofing
  a real browser.
- **Withdrawing consent**: when an event arrives with `consent: false`
  — an explicit decline, not merely unset — and the visitor still has a
  `genug_vid` cookie, the server clears it. So calling `setConsent(false)`
  from your banner's reject path removes the identifier on the visitor's
  next event, usually within seconds. This has to happen server-side —
  the cookie is `httpOnly`, so your own page JavaScript cannot delete
  it. Note that withdrawal stops future identification; it does not
  delete events already collected, which is the separate erasure tool
  below, and it does not stop collection — consentless events carry on.
  The thing that stops collection outright is `optOut()`, described
  under [Running without a consent banner](privacy.md#running-without-a-consent-banner).
- <a id="retention"></a>**Retention**: `RETENTION_DAYS` (see [Configuration](deploying.md#configuration))
  controls how many days of events, rejected events and bot activity are
  kept before the daily job deletes the rest. **Defaults to 425 (~13
  months)** — deliberately, and loudly: an unset value used to mean
  forever, and defaulting to a real number instead is worth more than a
  full explanation each time it's mentioned, so see
  [decisions.md](decisions.md) under "Data lifecycle" for why it
  changed and what it means if you're upgrading from a version where it
  didn't. Set `RETENTION_DAYS=-1` to keep events forever, explicitly —
  the way unset used to, now that omitting it no longer says that for
  you. (`0` is refused rather than accepted: "0 days" reads as "keep
  nothing", which is the opposite of what it would do.)
  425 is a commonly used figure, and comfortably under what France's
  CNIL allows for exempted analytics — a 25-month ceiling on the
  underlying data, separate from the 13-month ceiling on the tracker
  itself that this project's consent cookie already follows; it is not
  a rule laid down by a German authority, so treat it as a defensible
  starting point rather than an authority to cite. **The
  code default doesn't write your privacy notice for you** — Art.
  13(2)(a) still expects your notice to _state_ the period, even though
  the software now picks a reasonable one without being asked.
- <a id="deletion-and-erasure"></a>**Deletion**: ask your AI agent to erase a visitor — it calls the
  `delete_visitor_data(visitor_id, confirm)` MCP tool. Called without
  `confirm: true` it deletes nothing and only reports how many events
  would be affected, so the agent can show you that count and get an
  explicit yes before calling it again with `confirm: true`. On a
  deployment started with `READ_ONLY=true` the tool does not exist;
  erasure there means running the delete against the database
  yourself.

  **Read this before you promise anyone erasure.** The tool needs a
  `visitor_id`, and nothing Genug stores can be worked backwards to one.
  But the id is not unknowable: it is
  `HMAC(SALT_SECRET, "YYYY-MM-DD")` over the truncated address and the
  User-Agent, so a data subject who supplies their address, their
  browser's User-Agent and the dates they visited gives you everything
  needed to recompute the ids and erase those rows. That is the case
  Art. 11(2) describes, where the subject provides information enabling
  identification and Arts. 15 to 20 apply again — so a request backed by
  those details should be honoured rather than refused. The same lookup
  problem, and the same answer, applies to an Art. 15 access request and
  an Art. 21 objection, not only to Art. 17.

  What remains true is that you cannot do it from your side alone, and
  that an unaided request cannot be fulfilled. For consentless traffic
  there is no way to find the
  right one: the ID is a daily-rotating hash the visitor never sees and
  never receives, and nothing in Genug maps a person to it. That is a
  consequence of storing no stable identifier, not an oversight — but
  it means an Art. 17 request from a consentless visitor cannot be
  fulfilled, and the case GDPR provides for that (Art. 11: a controller
  who cannot identify the data subject) is something you have to state
  in your own privacy notice rather than assume. For a consented
  visitor the ID is the `genug_vid` cookie value, which is `HttpOnly` —
  so you get it from the request that person is making, not from asking
  them to read it off their own machine.

  Deleting also does not reach the backups: the daily snapshots hold
  the rows for up to 7 more days, and an off-host copy keeps them for
  as long as you keep it. Delete the snapshots too if the request has
  to be complete, or say in your notice how long the residue lives.
  There's no undo on the live database.

- **Health check**: `GET /healthz` returns `200` if the server can
  reach its database, `500` otherwise — point your host platform's
  health check (e.g. Coolify's) at it.
- **Backups**: on by default (`LOCAL_BACKUPS=true`, see
  [Configuration](deploying.md#configuration)) — a daily local backup, keeping the last 7 days, in
  a `backups` folder next to `DB_PATH` (so it's on the same persistent
  volume automatically). The event schema files from `EVENTS_PATH` are
  copied beside each dated database, because a database restored
  without them is full of events nothing can describe any more.
  The `CONTEXT_PATH` folder is copied beside them too, for the same
  reason: `ground-rules.md` could be re-seeded from the image, but
  nothing can re-create `history.json` — your own record of what
  happened to the site. Set
  `LOCAL_BACKUPS=false` to opt out. This
  uses SQLite's own "Online Backup API"
  (`better-sqlite3`'s built-in `db.backup()`), which is safe to run
  against a live, actively-written database — unlike a plain file copy,
  which can miss recent commits or copy the file mid-write while the
  database is in WAL mode (the mode this project always uses). A local
  backup only protects against mistakes (a bad migration, an accidental
  deletion) — it lives on the same volume as the live database, so it
  doesn't protect against losing that volume/disk entirely. For that,
  copy those files off the host as well: see below.

## Copying backups off the host

The daily job above already produces what you want to copy. Copy **the
`backups` folder**, not the live database — those files are finished,
consistent snapshots, whereas `genug.db` is open and in WAL mode, so a
plain file copy of it can be torn or miss recent commits. That also
means the off-host job needs no SQLite tooling and no coordination with
the running server: it is copying ordinary files.

```sh
# /etc/cron.d/genug-offhost — every night at 03:30
30 3 * * * root rsync -a /srv/genug-data/backups/ backup@offsite:/backups/genug/
```

That assumes a **bind mount** (`-v /srv/genug-data:/data`), so the files
are visible on the host. With a **named volume** (`-v genug-data:/data`,
the default in the [Docker instructions](deploying.md#build-and-run-with-docker)) there is no host path to
read — take the files out of the container instead, then copy them on:

```sh
docker cp genug:/data/backups /srv/genug-backups
```

(`genug` here and below is the container's name — whatever you passed to
`docker run --name`, or whatever Coolify calls it.)

Any transport works — `rsync`/`scp` to another machine, `rclone` to
object storage, `restic` if you want encryption and deduplication. Two
things worth knowing either way:

- **Deliberately no `--delete`.** The local folder keeps 7 days and
  prunes itself; without `--delete` the off-host copy accumulates
  beyond that, which is usually the point of having one. Prune it on
  whatever schedule you actually want — and note that retention and
  erasure only touch the live database, so whatever you keep here keeps
  the rows both of those removed.
- **There is no fixed hour to synchronise with.** The server backs up
  once at startup and every 24 hours from then, so the time drifts every
  time the container restarts. It doesn't matter: the folder always
  holds the last 7 days, so a job running once a day always finds recent
  snapshots.

## Restoring one

Stop the container first — restoring underneath a running server means
writing files it still has open.

```sh
docker stop genug

cd /srv/genug-data                           # or: docker cp the files in
rm -f genug.db genug.db-wal genug.db-shm     # see the warning below
cp /restored/genug-2026-09-10.db genug.db
rm -rf events && cp -r /restored/genug-2026-09-10-events events
chown -R 1000:1000 genug.db events           # the container runs as uid 1000

docker start genug
```

**Delete the `-wal` and `-shm` files.** This is the step that looks
optional and isn't. If you drop a restored database in place while the
old write-ahead log is still sitting beside it, SQLite replays that log
on top of your backup — you silently get back rows the backup didn't
contain, and `PRAGMA integrity_check` still reports `ok`. A restore that
looks clean and isn't is worse than one that fails.

The dated `-events` folder is the event schemas that were live when that
backup was taken. Restoring a database without them leaves you with rows
nothing can describe. If you keep your schemas in the repo rather than
on the volume, that folder will be absent and there is nothing to
restore — your image already carries them.

**Test this once, on a spare machine, before you need it.** An untested
restore is a guess, not a backup.

## Migrating the database

The one case that _does_ need more than a code change: adding or
changing a column on the shared `events` table itself (not a new event
type — that is [one JSON file](client.md#defining-your-own-events)). That's tracked in `server/db/migrations.ts`, as an
ordered, append-only list of migration functions:

```ts
const migrations: ((db: Database.Database) => void)[] = [
  (db) => db.exec(`CREATE TABLE events (...)`), // migration 0 — already shipped
  // Add new migrations here, as a new entry at the end of this array:
  (db) =>
    db.exec(`ALTER TABLE events ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`),
];
```

Append a new function to the end of the array — **never edit or remove
an already-shipped one**, since a database that already ran it has that
recorded in its own `PRAGMA user_version`, and changing the code
afterward wouldn't retroactively fix anything on databases that already
applied the old version. The next server startup runs whichever
migrations that specific database hasn't applied yet, automatically —
no manual step, no separate command to run.
