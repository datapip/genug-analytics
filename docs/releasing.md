# Releasing a version

Commit freely. A tag is a label you stick on afterwards, when you're
happy with what's there — not something to plan around.

**The tag is the gate, not the commit.** Pushing to `main` publishes
nothing; only a tag builds an image someone can pull. So review happens
here, once per release, rather than on every commit — which is what
keeps the cost of it low enough to actually do.

## Before you tag

Four things, in this order.

**1. Which surfaces changed since the last tag?** `git diff --stat
v<last>..HEAD` answers it. Each one below has a specialist who should
have looked at it — during the work, or now, before the tag goes out.
They are advisory and read-only, so the cost is a turn; the cost of
skipping one is a deployment that is subtly wrong, which is the failure
this project cares most about.

| Changed                                            | Ask                  |
| -------------------------------------------------- | -------------------- |
| An event's fields, props, consent or what's stored | `legal-advisor`      |
| `/events`, auth, the CSP, rate limiting            | `security-expert`    |
| `apps/cockpit/`                                    | `ux-expert`          |
| `server/lib/`, `server/routes/`, identity/sessions | `testing-specialist` |
| Anything crossing package boundaries, a dependency | `architect`          |

Hand them what they can't gather themselves: absolute paths, and a
screenshot on disk for anything visual. A cockpit review with no
screenshot is a source review.

**2. Write the `CHANGELOG.md` entry** while you still remember what
changed and why. Reconstructing it from `git log` afterwards is how
entries end up being a list of commits rather than a description of
what's different for whoever pulls the image.

**3. Update the version references in the docs.** `grep -rn
"genug-analytics:v0\." README.md docs/` — the quick start and the
Coolify compose example both name a tag, and both have gone stale
before. Anything telling a reader "this isn't in the released image
yet" needs re-reading too: once the tag is cut, it usually isn't true
any more.

**4. Re-read the product website's claims.** `genug-analytics.com` is a
separate repo that describes this tool from the outside — features, how
it works, what it collects. Nothing links the two, so a release can
change behaviour the site still describes the old way, and the site is
what a stranger reads first.

The privacy page is the sharp end. It states what the script collects
and what is stored; if this release changed a field, the envelope, or
the consent behaviour, that page is wrong until someone edits it, and
wrong there is a legal exposure rather than a stale sentence. Check it
against `docs/privacy.md` whenever `legal-advisor` appeared in step 1.

## Which number to bump

What changed _for the user_?

| Change          | Bump    | Example       |
| --------------- | ------- | ------------- |
| Fixed something | `patch` | 0.1.0 → 0.1.1 |
| Added something | `minor` | 0.1.0 → 0.2.0 |
| Broke something | `major` | 0.1.0 → 1.0.0 |

While the version starts with `0.`, breaking changes are expected —
that's what the leading zero signals. `1.0.0` is the promise to stop
breaking things casually.

## The flow

```sh
npm run build --workspaces && npm test --workspaces && npm run lint && npm run format:check
npm version minor -m "Release %s"
git push --follow-tags
```

Despite the name, `npm version` has nothing to do with publishing to
npm — nothing here is published. It's just a local command that bumps a
number, commits, and tags.

**Which number?** It reads the current version from `package.json`
(`0.1.0`) and you tell it which part to increase. `minor` → `0.2.0`. You
never type the number yourself, so `package.json` and the tag can't
drift apart.

**What's `%s`?** A placeholder npm replaces with the new version, so
`-m "Release %s"` becomes the commit message `Release 0.2.0`.

**What actually happens:**

1. Reads `0.1.0` from `package.json`
2. Works out the next minor → `0.2.0`
3. Writes it into `package.json` and `package-lock.json`
4. `git add` those two files
5. `git commit -m "Release 0.2.0"`
6. `git tag -a v0.2.0`
7. `git push --follow-tags` sends the commit **and** the tag

Six steps you'd otherwise do by hand, in one command.

Step 7 is the one worth remembering: a plain `git push` sends commits
only, and the tag would stay on your machine.

**What happens after the push:** a `v*` tag is also a CI trigger (see
`.github/workflows/ci.yml`) — once `build-and-test` passes on that tag,
`publish-image` builds the `Dockerfile` and pushes it to
`ghcr.io/datapip/genug-analytics:<tag>`, stamped with
`GENUG_VERSION=<tag>`. A plain push to `main` never publishes anything;
only a tag does.

## Notes

- **`npm version` refuses to run on a dirty working tree.** That's
  deliberate: it forces you to tag a clean, tested state.
- **Don't move a tag that's already public.** Someone may already have
  that version, and already have pulled the image published under it.
  Cut a new one instead.
- GitHub turns each pushed tag into a Releases entry automatically.
