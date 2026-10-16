# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-10-16

### Added

- `rules` option: pattern rules that inspect any tool by name, next to the unchanged guards. Each
  rule has an `id`, a `kind` (`refuse`, the default, fails the call; `warn` lets it run and appends
  the message to its result), the `tools` it inspects, `match` patterns (`/body/flags` or plain) and
  a `message` with `{id}`, `{tool}`, `{match}`, `{directory}`, `{subject}` placeholders.
- Rule subjects: `command` for `shell`/`bash` (with the `workdir` as a `cd` prefix), `path` and
  `content` for `edit`/`write`/`patch`, `code` for Code Mode `execute`, `name` and `input` for any
  other tool; `on` restricts a rule to some of them.
- `except` patterns that ignore a match by its matched text, `allow_from` directories whose sessions
  skip a rule, and `unless_turn_tool`, which passes a rule when the current turn already holds a
  completed call of the named tool (fails open when the session context is unavailable).
- `tool.execute.after` hook for warnings, registered only when a warn rule is configured.
- Load-time validation: invalid rules are dropped with a `[project-guard]` warning on stderr.
- Log lines `refused <tool> by rule <id> …` and `warned <tool> by rule <id> …`.
- Documentation of rules in `docs/configuration.md` (options, subject fields, texts, examples) and
  `docs/SDD.md` (rules engine and rationale).

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

[Unreleased]: https://github.com/rojosinalma/opencode-project-guard/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/rojosinalma/opencode-project-guard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rojosinalma/opencode-project-guard/releases/tag/v0.2.0
