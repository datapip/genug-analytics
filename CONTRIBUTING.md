# Contributing

Thanks for wanting to help. Genug is small on purpose and maintained by
one person in their spare time, so the most useful contributions are
the ones that stay small.

## Before you write code

- **Bugs:** open an issue with what you did, what you expected and what
  happened. A wrong number with no error is the bug this project cares
  about most, so report one even if you're not sure.
- **Anything bigger than a fix:** open an issue first and describe the
  problem, not only the solution. A lot has been decided already, and
  [docs/decisions.md](docs/decisions.md) says why. A pull request that
  arrives unannounced and undoes one of those decisions is likely to be
  closed, however good the code.
- **Security problems:** don't open an issue. See
  [SECURITY.md](SECURITY.md).
- **Your own events, tools or cockpit changes for your deployment:**
  those don't need to come back here. The recipes in [docs/](docs/)
  are written for exactly that.

## The rules

[AGENTS.md](AGENTS.md) is the contract for every change, by a person or
an AI assistant. The short version:

- The stored envelope is fixed. A new event never needs a database
  change.
- A tool answers one question, never takes raw SQL, and its description
  says what the number means.
- A mistake must look like a mistake: an explanatory error, never an
  empty result that reads as "no data".
- No new runtime dependency without a real reason. The current four
  are the whole list.
- The cockpit has no framework, bundler or build step.

## Working on it

```sh
npm install
npm run build && npm test && npm run lint && npm run format:check
```

All four have to pass, as they do in CI. Tests use Node's built-in
`node:test` and sit next to the file they test (`x.ts` and
`x.test.ts`). A fix comes with a test that fails without it.

Commit messages are short, lowercase and imperative, with no prefix:
`save bot count on shutdown`. One topic per pull request.

Say in the pull request what changes for someone running Genug; that
becomes its line in [CHANGELOG.md](CHANGELOG.md) at the next release. A
change to what is collected or stored also goes in
[docs/privacy.md](docs/privacy.md).

## License

Contributions are released under the [MIT license](LICENSE), the same
as the rest of the project.
