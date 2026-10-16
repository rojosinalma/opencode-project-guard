# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-16

First public release.

### Added

- `tool.execute.before` hook that refuses `edit`, `write` and `patch` calls whose target lies under a
  guarded path when the session is rooted outside the guard's owner.
- Shell write detection for `shell`/`bash` commands: redirections, `tee`, `sed -i`, `perl -pi`,
  `rm`/`mv`/`cp`/`mkdir`/`touch`/`chmod`/`chown`, `git -C <dir>` mutating subcommands and
  `docker compose` lifecycle commands (by `-f` file or current directory), with `cd` tracked per
  `&&`/`;`/`|` segment. Reads and read-only subcommands always pass.
- `guards[]` option (`owner`, `paths`, optional `message` with `{owner}`, `{target}`, `{tool}`,
  `{directory}` placeholders) and a `debug` option that logs allowed calls too.
- Fail-open wrapper: any internal fault is logged as `[project-guard]` and lets the call through.
- Bun test suite over the exported pure functions, run on every push and pull request.
- Documentation: `docs/configuration.md` (every option, refusal text, logging, caveats) and
  `docs/SDD.md` (design and rationale).

### Changed

- Licence to AGPL-3.0.

[Unreleased]: https://github.com/rojosinalma/opencode-project-guard/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rojosinalma/opencode-project-guard/releases/tag/v0.2.0
