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
be recognised across days. The cookie's value is that day's hash. So
the visitor's earlier events from the same day, recorded before they
consented, join the persistent ID too. Say so in your notice.

Two things worth stating plainly, because they shape what you have to
tell your own users. Consent selects _how_ a visitor is identified,
not _whether_ events are recorded: consentless events are still
stored, under a daily-rotating ID. The salt behind that ID is random,
kept only for its day, and replaced at midnight UTC. While it exists,
anyone with access to the server can recompute today's ID from a known
address and User-Agent. After midnight, nobody can. Genug ships no consent banner; wiring
your own to `setConsent()` is your site's job. The full model is in
[decisions.md](decisions.md) under "Visitor identification".

**What an EU operator still has to do.** Genug sets no cookie in
consentless mode, which removes the storage half of § 25 TDDDG.
Whether reading the page address and referrer counts as "access" is
not settled (see [Where the argument is not settled](#where-the-argument-is-not-settled)).
Recognising a visitor within one day by a hash of their address block
and User-Agent is the same pattern the common cookieless analytics
tools use. It is a defensible reading rather than a settled one, and it is not a legal opinion: if the site is a client's,
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
| `idempotency_key`  | Only when you pass one yourself — see the note on order numbers below                |

`props` is your schema and your choice ([defining events](client.md#defining-your-own-events)), with one thing to know before
you write the notice: the built-in `page_view` event declares
`page_title` and `document_language` (the page's own `<html lang>`).
With `enableAutoPageTracking` on, both are sent with every page view.
Nothing is tracked on page load until you turn that on
([tracking page loads](client.md#tracking-page-loads)). The other two
built-ins record what a visitor clicked, once `enableAutoLinkTracking`
is on: the outbound link's URL, host and visible text, or the
downloaded file's URL, extension and link text.

**Order numbers.** An order number, as an idempotency key or as a
prop, links the visitor's session to a named customer in your shop.
Everything else in that session then belongs to a known person. Send a keyed hash of the order number instead: see
[client.md](client.md#from-javascript).

The consent cookie is named `genug_vid`. It holds the visitor ID and
nothing else, is set `HttpOnly; Secure; SameSite=Lax`, and expires 13
months after the visitor's last event. France's CNIL names 13 months
as a ceiling, but it also says the lifetime should not be extended on
each visit. This cookie is extended, so it relies on consent, not on
CNIL's exemption. Note that it is refreshed on each visit, so a regular visitor's identifier lives
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
else — 396 days (13 months) by default, or whatever period you've configured.

## Running without a consent banner

The usual reason to pick a tool like this is to run analytics without a
cookie banner. That is a decision about **your** deployment, not about
this software — so here is what Genug does, what it leaves to you, and
where the argument is genuinely unsettled. **None of this is legal
advice, and it does not replace running it past your data protection
officer.** What it should do is make that conversation short, because
most of the usual objections are already answered in the architecture.

If you would rather collect nothing without consent, load the script
only after the visitor accepts:
[loading only after consent](client.md#loading-only-after-consent).

### What Genug does for you

**No storage on the visitor's device (§ 25 TDDDG).** In
the default consentless mode there is no cookie, no `localStorage`, no
`sessionStorage`, and no fingerprinting — no canvas, no screen or font
enumeration, no hardware probing. The script reads the page's own URL,
title and `<html lang>`, the referrer, and the host of a clicked link.
The one thing it ever writes to a device is the opt-out flag described
below, and only if a visitor asks for it.

**A visitor ID that cannot follow anyone across days.** The hash is
`truncated IP + User-Agent + today's salt`. The salt is random, and
it is kept only for its day, in one file beside the database
(`daily-salt.json`). At midnight UTC a new one replaces it, and the old
one is gone: no backup copies that file. So the same visitor gets an
unrelated ID tomorrow, and nobody can later work out which address was
behind an old ID. The address going into it is a network block, not a
connection. There is no cross-site identifier and no profile built on
the side.

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

`optOut()` writes a first-party cookie, `genug_optout=1`, and from that
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

The opt-out cookie holds no identifier. It lasts 400 days, the most
Chrome allows for any cookie. It is host-only: an opt-out
on `www.example.com` does not cover `shop.example.com`. If the script
runs on several hosts, put the opt-out link on each of them. It is not
`HttpOnly`, because the script must read it.

**Self-hosted, so there is no analytics vendor** to sign an Art. 28
DPA with, and no data leaving for a third party until you point an AI
agent at the MCP endpoint — see [What leaves your server when you ask](mcp.md#what-leaves-your-server-when-you-ask).

One request leaves the server on its own. Once at startup and once a
day, it asks GitHub's API whether a newer version exists. That request
carries no visitor data, but GitHub sees your server's address. Set
`UPDATE_CHECK=false` to turn it off
([configuration](deploying.md#configuration)).

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
  doing the balancing test and keeping it. Until midnight UTC, the
  day's salt is on your server, so today's ID can be recomputed from a
  known address and User-Agent.
- **Tell people, in your own privacy notice.** The field table under
  "What actually gets stored" is the list to write it from. Cover what
  is collected, the daily-rotating hash and what it is for, the legal
  basis, your retention period, the opt-out link, and — if you use an
  AI agent — that model vendor as a recipient.
- **State your retention period in the notice.** `RETENTION_DAYS`
  defaults to 396 days (13 months) unset — a real period now, not
  forever — but the software choosing a sensible default doesn't write
  your Art. 13(2)(a) notice for you. State it anyway, and change
  `RETENTION_DAYS` if 13 months isn't the period you actually want (see
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

## Text for your privacy policy

A starting point for the analytics section of a privacy policy. Fill
in the brackets, delete what doesn't apply, and translate it for a
German site. **Have a lawyer check it once** before you reuse it
across clients. It covers only analytics; the general parts (the
controller, the visitor's rights, the right to complain to a
supervisory authority) belong elsewhere in the policy.

> **Web analytics with Genug Analytics**
>
> We use Genug Analytics to understand how our website is used and to
> improve it. The software runs on a server at [hosting provider,
> country]. No third-party analytics service receives the data.
>
> **What we record.** For each page view or action: the page address
> without personal query parameters, the address of the page you came
> from, the time, the device type (e.g. mobile), the browser family,
> the browser's preferred language, [the page title and the page's
> language,] [links you click to other sites and files you download,]
> [further events: list them].
>
> **How we tell visits apart.** We do not store your IP address in
> the analytics data, and we set no cookie for this. Instead we shorten
> your IP address (e.g. 203.0.113.47 becomes 203.0.113.0), combine it
> with your browser's identification string and a key that changes
> every day, and store only a hash of the result. We can therefore
> recognise repeated visits on the same day, but not across days. The
> key is random and is deleted at the end of each day. After that,
> nobody, including us, can link the stored code to an IP address. If
> our server blocks unusually many requests from one address, it writes
> that address to a log, which is kept for [period].
>
> **Legal basis.** Art. 6(1)(f) GDPR. Our legitimate interest is
> understanding how our website is used, in order to improve it. No
> information is stored on your device for this. You are not required
> to provide this data. If you object, the website works the same.
>
> [**With your consent.** If you agree in our cookie settings, we set a
> cookie named `genug_vid`, so that we can tell returning visitors from
> new ones. It holds an identifier, computed on the day you consent
> from your shortened IP address and your browser's identification
> string. Events from earlier that day are then linked to it. It
> expires 13 months after your last visit. The legal basis is your
> consent, Art. 6(1)(a) GDPR and § 25(1) TDDDG. You can withdraw it at
> any time in [link to cookie settings]; the cookie is then deleted.
> This does not affect processing before the withdrawal.]
>
> **Retention.** Records are deleted automatically after [13 months].
> [The `genug_vid` cookie lasts 13 months after your last visit.] The
> `genug_optout` cookie lasts 400 days.
>
> **Your right to object.** You can object at any time (Art. 21 GDPR):
> [opt-out link]. We then store a cookie named `genug_optout` in your
> browser, which says only that you objected, and record nothing more
> from this browser. It applies only to this website address and this
> browser. Storing it is necessary to honour your objection (§ 25(2)
> No. 2 TDDDG). We cannot link data already recorded to you, because we
> do not know which hash is yours (Art. 11 GDPR). So we cannot find or
> delete it individually; it is deleted with everything else after [13
> months].
>
> **Recipients.** Our hosting provider [name] processes the data on our
> behalf under a data processing agreement (Art. 28 GDPR). [[Name of
> the agency or freelancer running the server] does so too, under a
> data processing agreement.] [To analyse the statistics we use [AI
> provider]. It receives aggregated figures and, where needed,
> individual records: page address, time, referring address, device
> type, browser, a session code and event details. It does not receive
> the visitor hash. It processes them on our behalf under a data
> processing agreement. [It is based in [country]. The transfer relies
> on [the EU Commission's adequacy decision for the EU-US Data Privacy
> Framework, Art. 45 GDPR; the provider is certified] / [EU standard
> contractual clauses, Art. 46(2)(c) GDPR; you can request a copy at
> [contact]].]]

Notes on the brackets:

- **Page title and links.** Only if `enableAutoPageTracking` or
  `enableAutoLinkTracking` is on. List your own events by what they
  record, not by their names.
- **The server log.** The rate limiter writes refused addresses to the
  log (see [above](#privacy-by-architecture)). State how long your
  host keeps logs, or point to the policy's general server-log section.
- **The consent paragraph.** Only if your banner calls `setConsent`.
- **Consent-only.** If you
  [load the script only after consent](client.md#loading-only-after-consent):
  keep "How we tell visits apart", but remove its first sentence. Drop
  the "Legal basis" paragraph and the brackets around the consent
  paragraph. Replace "Your right to object" with: "You can withdraw
  your consent at any time (Art. 7(3) GDPR) in [link to cookie
  settings]. This does not affect processing before the withdrawal."
- **The opt-out link.** A button that calls
  `window.genugAnalytics.optOut()` (see
  [a working opt-out](#what-genug-does-for-you) above). An inline
  `onclick` works only if your site's CSP allows inline handlers.
- **Retention.** The value of `RETENTION_DAYS`. The default, 396 days,
  is 13 months.
- **Running it for a client.** If you run the server for a client, you
  are their processor. Sign an Art. 28 agreement with them, and name
  yourself under Recipients.
- **The AI provider.** Only if you point an agent at the MCP endpoint.
  What it receives is in
  [What leaves your server when you ask](mcp.md#what-leaves-your-server-when-you-ask).
  Its terms decide whether it is a processor with a DPA; check them,
  and use a plan that offers one. The Data Privacy Framework applies
  only if the provider is listed at dataprivacyframework.gov.
