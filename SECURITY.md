# Security policy

Genug collects data about other people's visitors, so a security hole
here is a privacy problem for people who never chose to use it. Thank
you for taking the time to report one.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through
GitHub: **Security → Report a vulnerability** on this repository
([direct link](https://github.com/datapip/genug-analytics/security/advisories/new)).
Only the maintainer sees the report, and the fix can be prepared before
anything is public.

If you can't use GitHub, write through the
[contact form](https://genug-analytics.com/contact). Say that it is a
security report, but leave out the details, and a private channel will
be set up.

A useful report says what an attacker can do, what they need first (a
cockpit session, the MCP key, nothing at all), and how to reproduce it.
A proof of concept against your own deployment is welcome. Please don't
test against a deployment that isn't yours.

## What to expect

Genug is maintained by one person in their spare time. You'll get a
first reply within 7 days, and an estimate once the problem is
understood. Fixes ship as a new version, with a line in
[CHANGELOG.md](CHANGELOG.md) and a published advisory crediting you, if
you want that.

## Supported versions

Only the latest release gets fixes. There is no long-term branch: an
older version is updated by moving to the newest one, which
[CHANGELOG.md](CHANGELOG.md) describes.

## What counts

Anything that breaks a promise Genug makes, for example:

- `/events` (public, no sign-in) storing, revealing or executing
  something it shouldn't, or taking the server down with less effort
  than the documented rate limits allow.
- Getting into the cockpit or `/mcp` without the password or key, or
  doing more than `READ_ONLY` allows.
- Visitor-supplied text reaching the agent as an instruction rather
  than as data.
- A visitor being identified more precisely than
  [docs/privacy.md](docs/privacy.md) says, for example linking a
  consentless visitor across days.
- Data that erasure or retention should remove surviving on the live
  database.

Out of scope: problems that need the server's own files or shell
access, a deployment configured against
[docs/deploying.md](docs/deploying.md) (for example a proxied record
without `TRUST_PROXY`), and missing hardening with no attack attached.
Those are still welcome as ordinary issues.
