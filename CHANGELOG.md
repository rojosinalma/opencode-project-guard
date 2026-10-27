# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Docs and tests: the example approval rule's `file` regex also matches `library_file_id`, so a
  single-item queue call (`{library_file_id: 340, printer_id: 1}`) is compared like `file_ids`.

## [0.4.0] - 2026-10-16

### Added

- `unless_turn_tool_match`: a turn condition that passes a rule only when a completed call of the
  named tool (typically `question`) earlier in the same turn approved the *same job* the guarded call
  names. `answer` is a regex with named groups run over the option labels the user chose (a typed
  answer never approves), `code` maps each group to a regex that extracts the same key from the
  guarded call's subject text, `require` lists the keys the call must name. The rule passes when one
  approved job equals every extracted key, so a call naming two file ids never matches an approval
  for one.
- `{detail}` placeholder in rule messages; refusals and warnings from `unless_turn_tool_match` always
  end with `Approval check: <detail>.` saying what was approved and what the call names.
- Exported helpers `turnMessages`, `namedGroups`, `chosenAnswers`, `approvedJobs`, `extractKeys`,
  `matchApproval`, `resolveTurnToolMatch`; `RuleHit` carries the full `subject` text and the `detail`.

### Changed

- `unless_turn_tool_match` fails **closed**: an unavailable session context, a guarded message not
  found in it or a turn without a completed call of the tool refuses the call (logged). The plain
  `unless_turn_tool` keeps failing open. A rule may carry only one of the two conditions.

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

[Unreleased]: https://github.com/rojosinalma/opencode-project-guard/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/rojosinalma/opencode-project-guard/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/rojosinalma/opencode-project-guard/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/rojosinalma/opencode-project-guard/releases/tag/v0.2.0
