# Contributing

## Running it locally

The plugin is a single TypeScript file loaded by OpenCode on Bun; there is no build step.

1. Clone the repo into the plugins directory OpenCode reads:

   ```sh
   git clone https://github.com/rojosinalma/opencode-project-guard ~/.config/opencode/plugins/project-guard
   ```

2. Add a `plugins[]` entry with at least one guard to `opencode.jsonc` (see
   [docs/configuration.md](docs/configuration.md)); set `"debug": true` while developing so allowed
   calls are logged too.
3. Start a new OpenCode session in a directory outside the guard's `owner` and ask the agent to edit a
   guarded file. The call must fail with a `[project-guard] … refused` tool error, and the same line
   appears on the server's stderr. A session rooted in the owner must pass.
4. Plugins are loaded per location boot: after editing `index.ts`, start a new session (or restart the
   server) to load the change.

## Tests

```sh
bun install --frozen-lockfile   # fetches @opencode/plugin for type checking only
bun test
```

The suite in `test/project-guard.test.ts` drives the exported pure functions (`resolveOptions`,
`tokenize`, `splitSegments`, `shellWrites`, `targetsOf`, `decide`) with neutral example paths under
the home directory. Every new detection rule or shell construct gets a case: one that must be refused
and one that must pass. The same suite runs on every push and pull request in
`.github/workflows/run-tests.yml`.

## Code style and layout

- `index.ts` holds everything: options, path identity, shell analysis, decision, plugin object. Keep
  the pure functions exported so they stay testable without an OpenCode server.
- `test/` holds the Bun test suite.
- `docs/` holds the documentation (see below).
- Two-space indentation, no semicolons, double quotes — match the surrounding code.
- When in doubt the guard passes the call. A change that could introduce a false positive needs a
  test showing the read-only form still passes.
- `@opencode/plugin` stays a type-only import; the plugin has no runtime dependencies.

## Commits and PRs

- Plain, descriptive commit messages in the imperative ("Detect `rsync` destinations").
- One logical change per commit; keep refactors separate from behaviour changes.
- Every commit is GPG-signed (`git config commit.gpgsign true`).
- A PR describes what the guard now refuses or passes that it did not before, includes the tests and
  adds a line to `CHANGELOG.md` under *Unreleased*.

## Releasing

1. Move the *Unreleased* entries in `CHANGELOG.md` into a new `[X.Y.Z] - YYYY-MM-DD` section and set the
   same `version` in `package.json`.
2. Commit, then create a signed tag `vX.Y.Z` and push it with the branch.
3. Create the GitHub release from that tag with the changelog section as its notes.

## Documentation

- `README.md` — what it is, requirements, installation, usage, development, license. Nothing else
  goes there.
- `docs/configuration.md` — every option, the refusal text, logging, caveats.
- `docs/SDD.md` — design: the hook used, how targets are extracted, the shell parser's rules,
  decisions and their rationale, scope, operations.
- `CHANGELOG.md` — one section per release, product-level wording.
- `SECURITY.md` — how to report a vulnerability; `CODE_OF_CONDUCT.md` — the Contributor Covenant.
- `CONTRIBUTING.md` — this file.
