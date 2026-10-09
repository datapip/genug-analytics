# Privacy

What Genug stores, how it tells visitors apart, and what stays your
decision. This page describes the software. It is not legal advice:
whether your setup is lawful is a question for your lawyer.

## How visitors are told apart

**Without consent (the default)**, Genug sets no cookie and stores
nothing on the visitor's device: no `localStorage` or
`sessionStorage`, and no fingerprinting (no canvas, screen, font or
hardware probing). The script reads the page URL, title and
`<html lang>`, the referrer, its own opt-out cookie, and clicked links
once `enableAutoLinkTracking` is on. The visitor ID is a hash of three things:

- the visitor's address, cut to its network block (IPv4 to `/24`, IPv6
  to `/48`: `203.0.113.47` becomes `203.0.113.0`);
- the browser's User-Agent;
- a random salt that is replaced every midnight in your `TIMEZONE`.

So the same person gets a new ID every day, and two people sharing a
network block and a browser count as one. The salt lives in one file
beside the database (`daily-salt.json`), and Genug's own backup never
copies it. While today's salt exists, someone with access to the server can
recompute today's ID from a known address and User-Agent. After
midnight, nobody can, with two exceptions:

- A server stopped over midnight keeps the old salt until it starts
  again, and replaces it then.
- A snapshot of the whole volume or server, taken by your hosting
  provider, copies the salt file with everything else. Exclude it, or
  keep such snapshots no longer than a day.

**With consent**, Genug sets a first-party cookie, `genug_vid`, so a
returning visitor is recognised across days. It holds the visitor ID
and nothing else. Its value is that day's hash, so the visitor's
earlier events from the same day join the same ID. It is
`HttpOnly; Secure; SameSite=Lax`, and it expires 13 months after the
visitor's last event, so a regular visitor keeps it. Only the server
can delete it. That happens with the next event sent after
`setConsent(false)`, usually the next page view, or at once on
`optOut()`. `optOut()` also stops all counting in that browser, so use
it for withdrawal only if that is what you want.

Consent decides _how_ a visitor is identified, not _whether_ events
are recorded. Without consent, events are still stored under the daily
ID. Genug ships no consent banner; wiring yours to `setConsent()` is
your site's job ([client.md](client.md#loading-only-after-consent)).
If you would rather collect nothing without consent, load the script
only after the visitor accepts.

## What gets stored

Every event is one row with these fields and nothing else. There is no
profile, no cross-site identifier, and no raw address or User-Agent in
the database. This is the list to write your privacy notice from.

| Field              | Where it comes from                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| `event`            | The event name, e.g. `page_view`                                                     |
| `visitor_id`       | Derived server-side: the daily hash, or the cookie value once consented              |
| `session_id`       | Assigned server-side; a new one after 30 minutes of inactivity                       |
| `ts`               | The server's clock, UTC — never the visitor's                                        |
| `url`, `referrer`  | Sent by the script, with query strings filtered as below                             |
| `device_type`      | What the `User-Agent` header classified to: `mobile`, `tablet`, `desktop` or `other` |
| `browser`          | Likewise: `Chrome`, `Safari`, `Firefox`, `Edge` or `Other`                           |
| `visitor_language` | The first entry of the `Accept-Language` header, e.g. `de-DE`, if it is a locale tag |
| `consent_mode`     | `consentful` or `consentless`                                                        |
| `props`            | Whatever that event type declares — see below                                        |
| `idempotency_key`  | Only when you pass one yourself; see order numbers below                             |

**Props** are yours to define ([defining events](client.md#defining-your-own-events)).
The built-ins record:

- `page_view`: the page title and the page's `<html lang>`, once
  `enableAutoPageTracking` is on.
- Outbound clicks and downloads: the link's URL, host and text, or the
  file's URL, extension and link text, once `enableAutoLinkTracking` is
  on.

**Query strings are filtered.** By default only the six `utm_*`
parameters are kept, and the `#fragment` is dropped. The script filters
before it sends, and the server again on arrival. That keeps a
newsletter link's `?email=`, a reset token or a search query out of the
database. The same filter applies to clicked links and downloads.
You can widen the lists with `KEPT_QUERY_PARAMS` and `KEPT_HASH_VALUES`
([configuration](deploying.md#configuration)). What they let
through is stored, shown in the cockpit and returned to the agent. The
privacy template below names the defaults, so update it if you change
them. Ad click ids
(`gclid`, `fbclid`) and free-text parameters like `ref` can identify a
person, and `*` keeps everything, emails and tokens included.

**Two side tables** hold almost no visitor data. Rejected requests keep
the time, the event name tried, a reason and a message of up to 200
characters, which can quote part of the bad request. Bot activity keeps an hourly count. Both are deleted
with everything else after `RETENTION_DAYS`
([retention](operations.md#retention), 396 days by default).

**Genug's own log** is the one place it writes an address. When the
rate limiter refuses a client, it logs that client once a minute, so
you can tell a runaway script from a busy office. Too many wrong
danger-zone passwords in the cockpit log the address that typed them.
IPv4 addresses are logged whole, IPv6 addresses as a `/48` block. The
reverse proxy in front of Genug usually logs every visitor's full
address too; that is your proxy's setting, not Genug's.

## Keeping personal data out

Genug keeps identifying data out by design. Your own events can put it
back in. Most often this happens in one of these places:

- **Props.** An email address, a customer number, a name or a typed
  search query in a prop is stored as sent. Props are for what
  happened, never for who it happened to. A URL in a prop is not
  filtered; it is stored whole.
- **URLs.** A path like `/account/tobias-m/invoices` stores a name on
  every page view.
- **Order numbers.** An order number, as a prop or as an
  `idempotency_key`, links a session to a named
  customer. Send a keyed hash instead ([client.md](client.md#events-that-must-not-count-twice)).

## The opt-out

```js
genugAnalytics.optOut(); // stops everything, for this browser
genugAnalytics.optIn(); // resumes
genugAnalytics.isOptedOut(); // for rendering your own toggle
```

`optOut()` sets a cookie, `genug_optout=1`, and the script then sends
nothing until `optIn()` is called. It makes one last request so the
server can delete the `genug_vid` cookie, which the page's JavaScript
cannot touch. That request carries no event, URL or referrer, is sent
once, and is not stored.

The opt-out cookie holds no identifier and lasts 400 days. It is not
`HttpOnly`, because the script has to read it. It is host-only: an
opt-out on `www.example.com` does not cover `shop.example.com`, so put
the link on each host. Link it from your privacy notice.

## What leaves your server

Genug sends nothing to an analytics vendor; there is none. Two things
do leave the server:

- **What your AI agent fetches.** Tool results go to the model vendor
  when you ask a question. See
  [what leaves your server when you ask](mcp.md#what-leaves-your-server-when-you-ask).
- **An update check.** Once at startup and once a day, the server asks
  GitHub whether a newer version exists. It carries no visitor data,
  but GitHub sees your server's address. `UPDATE_CHECK=false` turns it
  off.

Your hosting provider can see everything on the server.

## Questions for your lawyer

Genug can't answer these for you:

- Can you run without a consent banner, or should the script load only
  after consent?
- What is your legal basis for the analytics?
- What does your privacy notice have to say? The template below is a
  starting point.
- Which data-processing agreements do you need: with your hosting
  provider, with the AI vendor, with anyone running the server for
  you?
- Does hashing the address and User-Agent without consent need
  consent itself (§ 25 TDDDG, Art. 5(3) ePrivacy)? Regulators read
  that rule broadly, and "no cookie" doesn't settle it.
- How do you answer an access or erasure request? Read
  [erasure](operations.md#deletion-and-erasure) first: a consentless
  visitor can't be looked up.

## Text for your privacy policy

A starting point for the analytics section of a privacy policy. It
states what Genug does. Fill in the brackets, delete what doesn't
apply, and have your lawyer add the legal basis and check the rest.

> **Web analytics with Genug Analytics**
>
> We use Genug Analytics to understand how our website is used and to
> improve it. The software runs on a server at [hosting provider,
> country]. No third-party analytics service receives the data.
>
> **What we record.** For each page view or action: the page address
> [with only utm_source, utm_medium, utm_campaign, utm_term, utm_content
> and utm_id kept from its query string, and no `#fragment`], the
> address of the page you came from, the time, the device type (e.g.
> mobile), the browser family, the browser's preferred language, [the
> page title and the page's language,] [links you click to other sites
> and files you download,] [further events: list them].
>
> **How we tell visits apart.** We do not store your IP address in
> the analytics data, and we set no cookie for this. Instead we shorten
> your IP address (e.g. 203.0.113.47 becomes 203.0.113.0), combine it
> with your browser's identification string and a key that changes
> every day, and store only a hash of the result. We can therefore
> recognise repeated visits on the same day, but not across days. The
> key is random and is replaced at the end of each day. After that,
> nobody, including us, can link the stored code to an IP address. If
> our server blocks unusually many requests from one address, it writes
> that address to a log, which is kept for [period].
>
> **Legal basis.** [Your lawyer fills this in.]
>
> [**With your consent.** If you agree in our cookie settings, we set a
> cookie named `genug_vid`, so that we can tell returning visitors from
> new ones. It holds an identifier, computed on the day you consent
> from your shortened IP address and your browser's identification
> string. Events from earlier that day are then linked to it. It
> expires 13 months after your last visit. You can withdraw your
> consent at any time in [link to cookie settings]; the cookie is then
> deleted [at once / with the next page you view].]
>
> **Retention.** Records are deleted automatically after [13 months]
> [, and from backups up to 7 days later].
> [The `genug_vid` cookie lasts 13 months after your last visit.] The
> `genug_optout` cookie lasts 400 days.
>
> **Opting out.** You can opt out at any time: [opt-out link]. We then
> store a cookie named `genug_optout` in your browser, which says only
> that you opted out, and record nothing more from this browser. It
> applies only to this website address and this browser. The website
> works the same after you opt out. [If you did not consent, we cannot
> link data from before today to you, because we do not know which hash
> is yours. So we cannot find or delete it individually; it is deleted
> with everything else after [13 months].]
>
> **Recipients.** The server is hosted by [name]. [[Name] runs it for
> us.] [To
> analyse the statistics we use [AI provider]. It receives aggregated
> figures and, where needed, individual records: page address, time,
> referring address, device type, browser, a session code and event
> details. It does not receive the visitor hash, except when we ask it
> to delete one visitor's data. [It is based in
> [country].]]

Notes on the brackets:

- **The page address.** The defaults are filled in. If you changed
  `KEPT_QUERY_PARAMS` or `KEPT_HASH_VALUES`, list what you run, or say
  "with its query string and fragment kept in full" for `*`.
- **Page title and links.** Only if `enableAutoPageTracking` or
  `enableAutoLinkTracking` is on. List your own events by what they
  record, not by their names.
- **The server log.** State how long your host keeps logs, or point to
  the policy's general server-log section. Your reverse proxy's access
  log belongs there too.
- **Withdrawal.** "At once" only if your withdrawal button calls
  `optOut()`, which also stops all counting; otherwise "with the next
  page you view".
- **Backups.** Genug's own snapshots keep rows up to 7 days. Name
  any off-host copy and how long you keep it.
- **The salt.** "Nobody can link" holds only if your host's volume
  snapshots skip `daily-salt.json` or last no more than a day.
- **Opting out, already recorded data.** The bracketed sentences hold
  for visitors without consent, and only for days before today. A
  consenting visitor's data can be found by the cookie's value. Ask
  your lawyer how to word access and erasure requests.
- **The consent paragraph.** Only if your banner calls `setConsent`.
  If you [load the script only after consent](client.md#loading-only-after-consent),
  remove the first sentence of "How we tell visits apart" and replace
  "Opting out" with how to withdraw consent.
- **The opt-out link.** A button that calls
  `window.genugAnalytics.optOut()`. An inline `onclick` works only if
  your site's CSP allows inline handlers.
- **Retention.** The value of `RETENTION_DAYS`. The default, 396 days,
  is 13 months.
- **The AI provider.** Only if you point an agent at the MCP endpoint.
  If you widened the query-string lists, it also receives whatever
  those parameters carry.
