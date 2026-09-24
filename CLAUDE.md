@AGENTS.md

## Claude Code

The rules and recipes are in `AGENTS.md`, imported above, so every
coding agent reads the same instructions. Only Claude-specific notes
belong in this file.

- `docs/decisions.md` is the design journal (~5,000 lines). It is
  deliberately **not** imported — an import loads at launch and would
  cost that context every session. Read it with your file tools when
  you need it: before proposing an architectural change, or when a rule
  in `AGENTS.md` looks arbitrary and you want the reasoning.
- If you are pairing with the maintainer on Genug itself rather than
  customising a deployment, the working agreement is in
  `docs/developing.md`.

## Use the subagents

Five advisory agents live in `~/.claude/agents/`. They report findings
and never edit files, so consulting one costs a turn and skipping one
costs a deployment that is subtly wrong — the failure this project
cares most about. Ask them without being told to, whenever they apply.

- **ux-expert** — before calling any cockpit change done. It is the
  only human-facing surface here and there is no framework catching
  mistakes. Reviews have found real defects: content unreachable on a
  phone, a selected state at 1.03:1 contrast, a live region that would
  never have been announced.
- **testing-specialist** — after changing `server/lib/`,
  `routes/events.ts`, identity/session logic, or the schema registry.
- **security-expert** — before touching auth, the CSP, rate limiting,
  or anything reachable from `/events`, which is public and unauthenticated.
- **legal-advisor** — whenever what is collected or stored changes: a
  new field, a prop that could identify a visitor, anything touching
  consent. See the Privacy invariants in `AGENTS.md` first.
- **architect** — before a change crossing package boundaries, adding
  a dependency, or reshaping the query layer.

They have read tools only, so hand them the evidence they cannot
gather: absolute file paths, and for anything visual, screenshots
saved to disk (they can `Read` an image). A cockpit review with no
screenshot is a source review.
