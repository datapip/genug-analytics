# Privacy and the law

What Genug stores, how a visitor is identified, and what an EU operator still has to do. Nothing here is legal advice.

## Privacy by architecture

No cookie by default. The visitor ID is a salted hash of a **truncated**
address plus the User-Agent, whose salt rotates every day — so nothing
is stored on the visitor's device and the same person gets a different
ID tomorrow. The address is cut to its network block before it is
hashed (IPv4 to `/24`, IPv6 to `/48`: `203.0.113.47` becomes
`203.0.113.0`), and the full address is never written to the database.
The one exception is the server log, described below. Two
visitors sharing a block and a browser therefore count as one person —
that is the trade being made, and it costs a little accuracy in the
visitor and session counts.

When a visitor consents, Genug switches to the conventional model — a
first-party cookie holding a persistent ID — so returning visitors can
be recognised across days.

Two things worth stating plainly, because they shape what you have to
tell your own users. Consent selects _how_ a visitor is identified,
not _whether_ events are recorded: consentless events are still
stored, under a daily-rotating pseudonym. And those IDs are
pseudonymous rather than anonymous — your server holds the secret the
salt is derived from, so a known IP and User-Agent can still be
re-identified for a given day. Genug ships no consent banner; wiring
your own to `setConsent()` is your site's job. The full model is in
[decisions.md](decisions.md) under "Visitor identification".

**What an EU operator still has to do.** Genug not setting a cookie in
consentless mode is what keeps § 25 TDDDG's consent requirement for
storing on a device out of the picture, and recognising a returning
visitor by IP and User-Agent instead is the same pattern the common
cookieless analytics tools use. It is a defensible reading rather than
a settled one, and it is not a legal opinion: if the site is a client's,
have counsel confirm it. What is not optional either way is that the
records are personal data, so you need a basis for them — for
consentless mode that is normally Art. 6(1)(f), legitimate interests,
which means doing the balancing test and offering a route to object
under Art. 21. You also owe your visitors the Art. 13 information at
collection, and your own Art. 30 record of processing. The good news
worth stating plainly: because you host this yourself, there is no
analytics vendor to sign an Art. 28 DPA with. Your hosting provider is
still a processor, and so is the model vendor behind whatever agent you
point at the MCP endpoint — see [What leaves your server when you ask](mcp.md#what-leaves-your-server-when-you-ask).

Query strings are filtered rather than stored whole. Only campaign and
click-id parameters survive (`utm_*`, `gclid`, `fbclid`, `msclkid`,
`ttclid`, `ref`, `source`); everything else is dropped by the client
before it sends and again at ingestion, and the `#fragment` is dropped
entirely — an OAuth implicit response puts an access token there. Note
that `ref` and `source` are kept, so a link written `?ref=a-person's-name`
does store that name. That keeps a newsletter link's
`?email=`, a password reset's token and a site search's typed query out
of the database, and out of whatever you point at the MCP endpoint. The
same filter applies to the clicked link on `outbound_link_click` and
`file_download` (`target_url`, `file_url`), however they are sent.
Props on your own events are stored as sent, so don't put a raw URL in
one. The
one place an address is written down is the server log, once per minute
per refused client, when the rate limiter refuses traffic — otherwise
you would have no way to tell a runaway script from a busy office. An
IPv6 address is narrowed to a block there, so the line names a network
rather than a machine; an IPv4 one is written whole, because the limiter
counts it whole.

### What actually gets stored

Every event is one row with the fields below and nothing else. There is
no profile built up on the side, no cross-site identifier, and neither
a raw IP address nor a User-Agent string anywhere in the database —
only the hash derived from both, and the device type and browser the
header classified to. This is the list to write your own privacy
notice from.

| Field              | Where it comes from                                                                  |
| ------------------ | ------------------------------------------------------------------------------------ |
| `event`            | The event name, e.g. `page_view`                                                     |
| `visitor_id`       | Derived server-side: the daily hash, or the cookie value once consented              |
| `session_id`       | Assigned server-side; a new one after 30 minutes of inactivity                       |
| `ts`               | The server's clock, UTC — never the visitor's                                        |
| `url`, `referrer`  | Sent by the script, with query strings filtered as above                             |
| `device_type`      | What the `User-Agent` header classified to: `mobile`, `tablet`, `desktop` or `other` |
| `browser`          | Likewise: `Chrome`, `Safari`, `Firefox`, `Edge` or `Other`                           |
| `visitor_language` | The first entry of the `Accept-Language` header, e.g. `de-DE`, if it is a locale tag |
| `consent_mode`     | `consentful` or `consentless`                                                        |
| `props`            | Whatever that event type declares — see below                                        |
| `idempotency_key`  | Only when you pass one yourself (e.g. an order id)                                   |

`props` is your schema and your choice ([defining events](client.md#defining-your-own-events)), with one thing to know before
you write the notice: the built-in `page_view` event declares
`page_title` and `document_language` (the page's own `<html lang>`),
so those are collected by default on every page view unless you edit
that event. The other two built-ins record what a visitor
clicked: the outbound link's URL, host and visible text, or the
downloaded file's URL, extension and link text.

The consent cookie is named `genug_vid`. It holds the visitor ID and
nothing else, is set `HttpOnly; Secure; SameSite=Lax`, and expires 13
months after the visitor's last event — the ceiling EU data-protection
authorities treat as the maximum for an analytics identifier. Note that
it is refreshed on each visit, so a regular visitor's identifier lives
on rather than lapsing 13 months after they first consented; re-asking
for consent on a schedule is your consent manager's job, not this
cookie's. It is only ever set for a visitor who consented, and cleared
again when one withdraws.

Two side tables hold almost no visitor data: rejected requests keep a
reason and a validation message truncated to 200 characters, and bot
activity keeps an hourly count. The message names the field that
failed, and for a few kinds of failure quotes the value that was sent
— so a malformed request can leave a fragment of its own payload
there. Those rows are pruned by `RETENTION_DAYS` ([operations](operations.md#retention)) along with everything
else — 425 days by default, or whatever period you've configured.

## Running without a consent banner

The usual reason to pick a tool like this is to run analytics without a
cookie banner. That is a decision about **your** deployment, not about
this software — so here is what Genug does, what it leaves to you, and
where the argument is genuinely unsettled. **None of this is legal
advice, and it does not replace running it past your data protection
officer.** What it should do is make that conversation short, because
most of the usual objections are already answered in the architecture.

### What Genug does for you

**No access to, or storage on, the visitor's device (§ 25 TDDDG).** In
the default consentless mode there is no cookie, no `localStorage`, no
`sessionStorage`, and no fingerprinting — no canvas, no screen or font
enumeration, no hardware probing. The script reads the page's own URL,
title and `<html lang>`, the referrer, and the host of a clicked link.
The one thing it ever writes to a device is the opt-out flag described
below, and only if a visitor asks for it.

**A visitor ID that cannot follow anyone.** The hash is
`truncated IP + User-Agent + a salt derived from today's date`. It
cannot be recomputed tomorrow, and the address going into it is a
network block, not a connection. There is no cross-site identifier and
no profile built on the side.

**The raw address and the User-Agent header are never stored.** Both
go into the hash, the header is classified to a device type and
browser, and then both are dropped. The only place an address appears
at all is the server log, once a minute, when the rate limiter refuses
traffic.

**Query strings are filtered before they are stored** — only campaign
and click-id parameters survive. A newsletter link's `?email=`, a
password reset token and a site-search query never reach the database.

**A working opt-out**, which is what an Art. 21 objection needs:

```js
genugAnalytics.optOut(); // stops everything, for this browser
genugAnalytics.optIn(); // resumes
genugAnalytics.isOptedOut(); // for rendering your own toggle
```

`optOut()` writes a first-party `genug_optout` flag, and from that
moment the script is silent — no page views, no clicks, no route
changes, nothing, until `optIn()` is called.

It makes **exactly one** request on the way out, and then never again.
That request carries no event, no URL and no referrer; its only job is
to let the server clear the `genug_vid` cookie, which is `HttpOnly` and
therefore cannot be deleted by the page's own JavaScript. Nothing is
stored for it — it does not become an event, and not a rejected one
either. The alternative was to go silent immediately and leave that
cookie to expire on its own in 13 months, inert but still sitting
there; one request that removes an identifier from someone's device is
the better trade. Put these calls behind a link in your privacy policy
and you have an objection route that works.

**Self-hosted, so there is no analytics vendor** to sign an Art. 28
DPA with, and no data leaving for a third party until you point an AI
agent at the MCP endpoint — see [What leaves your server when you ask](mcp.md#what-leaves-your-server-when-you-ask).

### What is still yours to do

- **Keep end-user data out of `props`.** This is the one that will
  actually bite you. Event props are yours to define, and nothing stops
  you putting an email address, a customer number, a name typed into a
  form, or a search query in one. Do that and every argument above
  stops applying: you are processing directly identifying data through
  a system designed on the premise that you are not. Props are for
  what happened — a plan name, a category, a count — never for who it
  happened to. The same goes for your own URLs: a path like
  `/account/tobias-m/invoices` puts a name in the database on every
  page view.
- **Name a legal basis and write it down.** For consentless mode that
  is normally Art. 6(1)(f) legitimate interests, which means actually
  doing the balancing test and keeping it. The IDs are pseudonymous,
  not anonymous: you hold the salt secret, so a given day's ID is
  reproducible from a candidate address and User-Agent.
- **Tell people, in your own privacy notice.** The field table under
  "What actually gets stored" is the list to write it from. Cover what
  is collected, the daily-rotating hash and what it is for, the legal
  basis, your retention period, the opt-out link, and — if you use an
  AI agent — that model vendor as a recipient.
- **State your retention period in the notice.** `RETENTION_DAYS`
  defaults to 425 days (~13 months) unset — a real period now, not
  forever — but the software choosing a sensible default doesn't write
  your Art. 13(2)(a) notice for you. State it anyway, and change
  `RETENTION_DAYS` if 425 isn't the period you actually want (see
  [operations.md](operations.md#retention)).
- **Add the Art. 30 record**, and remember your hosting provider is
  still a processor even though your analytics vendor no longer exists.
- **Know the limits of erasure** before you promise it — see
  [Erasure](operations.md#deletion-and-erasure). A consentless visitor cannot be looked up, by
  design.

### Where the argument is not settled

§ 25 TDDDG covers storing information on a device **and gaining access
to information already there**. Genug plainly does not store anything
(consentless mode), which is the half most banners exist for. The
access half is less clear-cut: the script reads the referrer, and the
request carries an address and a User-Agent that originate from the
visitor's device. The EDPB reads "access" broadly, and no German court
has settled how that lands for cookieless, IP-hash analytics.

Our reading is that recognising a visitor this way does not require
consent, which is the same ground every cookieless analytics tool
stands on. It is a defensible position, not a decided one. If the site
belongs to a client, or the exposure is anything but small, have a
Datenschutzanwalt confirm it rather than relying on this file.
