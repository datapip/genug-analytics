# Operating a deployment

How much traffic it takes, retention, opt-out and erasure, backups and restore, exporting your data, and the one kind of change that needs a database migration.

## How much traffic it handles

Measured with `scripts/load-events.mjs` on a laptop with an NVMe disk,
in Docker behind a reverse proxy. The measurements are in
[decisions.md](decisions.md) under "Check what a small VPS can do".

- **Collecting:** about **2,300 events a second**. A site with a
  million page views a day averages twelve. One address may send 600
  events a minute.
- **Storage:** about **0.4 KB per event**, so a million events is
  about 350 MB.
- **Reading** slows as the database grows, not as the period does:

| Events stored | Database | Cockpit page (7 days) |
| ------------- | -------- | --------------------- |
| 100,000       | 35 MB    | 21 ms                 |
| 1,000,000     | 356 MB   | 220 ms                |
| 5,000,000     | 1.8 GB   | 1.2 s                 |

Most agent questions take well under a second. Asking for a whole year
is the slow case: several seconds on a large database. If you only
look at recent weeks, a lower `RETENTION_DAYS` keeps everything fast.

### What server to rent

**2 vCPUs and 2 GB of RAM is comfortable; 1 GB works.** Genug uses one
core and about 250 MB. The rest of the memory goes to Linux, Docker
(about 200 MB) and the proxy, and spare memory caches the database.
More cores buy nothing. Running Coolify on the same box needs several
hundred MB more.

A VPS has slower cores and slower disks than the test machine, and
the disk limits how fast events are written. Run
`scripts/load-events.mjs` on your own server to get real numbers.

## Data lifecycle

- **Opting out**: `genugAnalytics.optOut()` stops the script for that
  browser and deletes the `genug_vid` cookie. See
  [the opt-out](privacy.md#the-opt-out).
- **Bot filtering**: requests to `/events` whose `User-Agent` matches a
  known crawler/automation-tool signature (or has no `User-Agent` at
  all) are silently dropped — no error, no stored row, same response as
  a real event. This is best-effort: it catches bots that identify
  themselves honestly (most crawlers do), not one deliberately spoofing
  a real browser.
- **Withdrawing consent**: call `setConsent(false)` from your banner's
  reject path. The server deletes the `genug_vid` cookie on the
  visitor's next event; the page can't, because the cookie is
  `HttpOnly`. Events already collected stay, and collection carries on
  without the cookie. To stop collection, use `optOut()`.
- <a id="retention"></a>**Retention**: `RETENTION_DAYS` (see
  [Configuration](deploying.md#configuration)) sets how many days of
  events, rejected events and bot activity are kept. A job at startup
  and then daily deletes the rest. **The default is 396 days (13 months).** Set `-1`
  to keep everything. `0` is refused, since "0 days" reads as "keep
  nothing", the opposite of what it would do. The privacy template
  has a slot for it.
- <a id="deletion-and-erasure"></a>**Deletion**: ask your AI agent to
  erase a visitor. It calls `delete_visitor_data(visitor_id, confirm)`.
  Without `confirm: true` it only reports how many events would go, so
  the agent can show you the count and ask before deleting. On a
  `READ_ONLY` deployment the tool doesn't exist; you run the delete
  against the database yourself.

  **Read this before you promise anyone erasure.** The tool needs a
  `visitor_id`, and Genug has no way to find one for a person:

  - **A consented visitor's** ID is the `genug_vid` cookie value. It is
    `HttpOnly`, so you read it from a request that person makes, not by
    asking them to look it up.
  - **A consentless visitor's** ID can be recomputed only on the day of
    the visit, before midnight in your `TIMEZONE`, from their address
    and their browser's User-Agent. After that the salt is gone, and
    their rows can't be found.

  How to answer an access or erasure request you can't match is a
  question for your lawyer.

  Deleting doesn't reach the backups: the daily snapshots keep the rows
  for up to 7 more days, and an off-host copy keeps them as long as you
  keep it. Delete the snapshots too if the request has to be complete.
  There is no undo on the live database.

- **Health check**: `GET /healthz` returns `200` if the server can
  reach its database, `500` otherwise — point your host platform's
  health check (e.g. Coolify's) at it.
- **Backups**: on by default (`LOCAL_BACKUPS=true`). Once at startup
  and then daily, a consistent snapshot goes into a `backups` folder
  next to `DB_PATH`, and the last 7 days are kept. Each dated snapshot
  comes with copies of the event definitions (`-events`) and the context
  folder (`-context`), since rows nothing describes, or a lost history,
  can't be re-created. The snapshot is safe to take while the server
  writes. It sits on the same disk as the database, so it protects
  against mistakes, not against losing the disk: copy it off the host
  (below).

- **Daily salt**: `daily-salt.json` beside the database holds the
  day's salt for the visitor hash, and is replaced at midnight in your
  `TIMEZONE`. A
  stopped server replaces nothing, so the last day's salt stays there
  until the next start. When you shut a deployment down for good, or
  for a long time, delete that file. Nothing is lost: a new one is
  made on start.

- **Update check**: once a day the server asks GitHub whether a newer
  version exists, so the cockpit can say so. `UPDATE_CHECK=false` turns
  it off.

## Copying backups off the host

Copy **the `backups` folder**, not the live database. The snapshots are
finished files. A plain copy of the live `genug.db` can be torn or miss
recent writes.

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

Any transport works: `rsync`, `rclone`, `restic`. The example has no
`--delete`, so the off-host copy keeps more than 7 days. Prune it on
your own schedule. Retention and erasure don't reach it. The backup
time drifts with each restart, but a daily job always finds recent
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
rm -rf context && cp -r /restored/genug-2026-09-10-context context
chown -R 1000:1000 genug.db events context   # the container runs as uid 1000

docker start genug
```

**Delete the `-wal` and `-shm` files.** Otherwise SQLite replays the
old log on top of your backup. You silently get back rows the backup
didn't contain, and `PRAGMA integrity_check` still says `ok`.

The `-events` and `-context` folders hold the event definitions and
history from the day of the backup. Restore them with the database.

**Test this once, on a spare machine, before you need it.** An untested
restore is a guess, not a backup.

## Your data

Everything Genug stores is in one SQLite file. There is no export
button: any SQLite tool reads it, and so do pandas, DuckDB and most BI
tools. Work from a backup, not the live `genug.db`. The image has no
`sqlite3`, so copy the file out first:

```sh
docker cp genug:/data/backups/genug-2026-09-10.db ./genug-export.db

sqlite3 -header -csv genug-export.db "SELECT * FROM events" > events.csv
```

A restart takes a fresh snapshot if you need one.

Three tables hold data:

| Table             | One row per                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `events`          | Stored event, with the fixed envelope: `event`, `visitor_id`, `session_id`, `ts`, `url`, `referrer`, `device_type`, `browser`, `visitor_language`, `consent_mode`, `props`. |
| `rejected_events` | Request `/events` refused, with the reason. It has no visitor or session.                                                                                                   |
| `bot_activity`    | Hour, with a count of bot requests dropped. It has no individual hits.                                                                                                      |

`ts` is an ISO 8601 UTC string. `props` is JSON text, so read a single
prop with `json_extract`. For a `list` prop, use `json_each`, because
`json_extract` returns the whole array as one string:

```sh
sqlite3 -header -csv genug-export.db \
  "SELECT ts, url, json_extract(props, '$.value') AS value
     FROM events WHERE event = 'purchase'" > purchases.csv
```

The event files in the dated `-events` folder next to each backup
describe what every event and prop means. Keep them with the export.

Before you pass an export on, two things:

- **It identifies visitors.** In consented mode, `visitor_id` comes from a
  cookie and stays the same across visits. In consentless mode it is a
  hash that changes daily, so it cannot link one day to the next, but it
  is still per-visitor. `url` and `props` hold whatever your pages and
  visitors sent. Handle the export like the database, under the same
  privacy notice.
- **Retention and erasure do not reach copies.** Both act on the live
  database only. Rows you exported stay in the export after the server
  deletes them, just as they do in backups. Delete an export you no
  longer need.

## Migrating the database

Only needed to add or change a column on the `events` table, never for
a new event type ([that is one JSON file](client.md#defining-your-own-events)).
Migrations are an append-only list in `server/db/migrations.ts`:

```ts
const migrations: ((db: Database.Database) => void)[] = [
  (db) => db.exec(`CREATE TABLE events (...)`), // migration 0 — already shipped
  // Add new migrations here, as a new entry at the end of this array:
  (db) =>
    db.exec(`ALTER TABLE events ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0`),
];
```

Add new ones at the end. **Never edit or remove a shipped one**: a
database that already ran it won't run it again. The next start runs
whatever that database hasn't applied yet.
