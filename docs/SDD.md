# Software design document

## Purpose

When several projects share one OpenCode server, an agent working in project A can reach into
project B's files with a plain `edit` or a shell command. Where B owns configuration that A must not
touch directly (rendered config, infrastructure definitions, generated files), that write is wrong even
when it works. `opencode-project-guard` turns such writes into a refusal with an explanation, so the
model reports what it needed instead of changing it, while sessions rooted in the owning project keep
working unchanged.

Design priorities, in order:

1. Never break a session: any internal fault logs and lets the call through.
2. No false positives: reads always pass, and the shell analysis passes whatever it cannot classify.
3. Clear refusals: the error says what was refused, why, and what to do instead.

## Architecture

One file, `index.ts`, exporting pure functions plus the plugin object as default export.

| Component | Where | Role |
|---|---|---|
| Options | `resolveOptions`, `expandHome` | normalises `plugins[].options` into `{ guards, debug }`, expands `~`, drops malformed guards |
| Path identity | `canonical`, `isUnder` | realpath-based "is X under root" so symlinked checkouts compare equal to their targets |
| Shell analysis | `tokenize`, `splitSegments`, `writesOfSegment`, `shellWrites` | turns a command line into the paths it would write |
| Target extraction | `targetsOf` | absolute write targets of one tool call (file tools and shell tools) |
| Decision | `decideFull`, `decide`, `rejection` | matches targets against guards and builds the refusal text |
| Hook | `plugin.setup` | registers `ctx.tool.hook("execute.before")` and applies the decision |

The plugin uses a single OpenCode hook, `tool.hook("execute.before")`. It receives the tool name,
the input and the session id before the tool runs; throwing an `Error` there aborts the call and the
message becomes the tool error the model sees. Nothing else is hooked and no state is kept between
calls.

`@opencode/plugin` is imported with `import type` only: the plugin directory may have no
`node_modules` of its own, and a type-only import is erased at runtime, so nothing has to be installed
where the plugin is loaded from.

## Data model / storage

None. The plugin holds the resolved options and the session directory in closure variables for the
lifetime of the location boot. It reads nothing from disk except `realpath` lookups on the paths it
compares, and writes nothing.

## Key flows

### File tools (`edit`, `write`, `patch`)

1. `targetsOf` takes the input's `filePath`/`path`/`file`/`file_path` and resolves it against the
   session directory (or the input's `workdir` when present).
2. For patches it also scans the patch text for `*** Update File:`, `*** Add File:`,
   `*** Delete File:` and `*** Move to:` lines, so every file a patch touches is a target.
3. `decideFull` skips guards whose `owner` contains the session directory, then refuses on the first
   target that is under one of a guard's `paths`.

### Shell tools (`shell`, `bash`)

1. `splitSegments` splits the command on `;`, newlines, `&&`, `||` and `|` outside quotes. `|` splits
   too, because `cat x | tee y` must expose `tee y`.
2. `shellWrites` walks the segments and tracks the working directory: a `cd`/`pushd` segment updates
   the cwd for the segments after it; a `cd` with no argument means the home directory.
3. `writesOfSegment` finds the write targets of one segment:
   - output redirections (`>`, `>>`, `2>`, `&>`), except `/dev/null` and fd duplications;
   - leading wrappers (`sudo`, `env`, `nohup`, `time`, `nice`, …) and `VAR=value` prefixes are
     stripped before the command is identified;
   - `tee`, `rm`, `mkdir`, `touch`, `truncate`, `rmdir`, `unlink`, `shred`: every positional argument;
   - `chmod`, `chown`, `chgrp`: every positional argument after the first;
   - `sed -i` and `perl -i`: the file operands after the expression;
   - `mv`, `cp`, `rsync`, `install`: the destination (and, for `mv`, the sources — moving a guarded
     file away is a write to it); `ln`: the link name;
   - `git`: the working tree (`-C <dir>` honoured) for writing subcommands such as `add`, `commit`,
     `checkout`, `reset`, `rebase`, `merge`, `push`, `pull`, `stash`, `clean`, `restore`, `tag`,
     `branch`; `log`, `diff`, `status`, `show` and friends pass;
   - `docker compose`, `docker-compose`, `podman compose`: the `-f`/`--file` and `--project-directory`
     arguments, or the cwd when none is given, for `up`, `down`, `restart`, `stop`, `start`, `rm`,
     `build`, `pull`, `create`, `kill`, `run`, `exec`, `cp`; `logs`, `ps`, `config` pass.
4. Targets starting with `-` or `$` are dropped (flags and unexpanded variables), everything else is
   resolved against the segment's cwd and handed to the same decision as file tools.

The tokenizer honours single and double quotes and backslash escapes; `$(…)`, heredocs and other
constructs stay opaque words, which can only make the detection miss, never block.

### Owner check

A guard never applies to a session whose directory is equal to or below the guard's `owner`.
Comparison goes through `canonical`, which resolves the longest existing prefix of a path with
`realpath` and appends the rest, so a symlinked checkout, its target and a not-yet-existing file
under either all compare consistently.

### Refusal

`rejection` builds the message: a fixed head naming the tool, the target, the owner and the session
directory, then either the guard's `message` (with `{owner}`, `{target}`, `{tool}`, `{directory}`
substituted) or the generic instruction to report the need instead of working around the guard. The
hook logs `[project-guard] refused …` and throws the message as the tool error.

## Configuration surface

`plugins[].options` in `opencode.jsonc`: `guards` (list of `{ owner, paths, message? }`) and `debug`.
Full reference and the caveats in [configuration.md](configuration.md).

## Decisions and rationale

- **Fail open, always.** The hook body is wrapped; any exception other than the deliberate refusal is
  logged and the call proceeds. A guardrail that can take a session down is worse than a missed write.
- **Conservative shell parsing instead of a full shell.** A real parser would still not know what a
  script or a `$(…)` expands to. Detecting the common direct forms (redirections, coreutils, `sed -i`,
  `git`, `compose`) catches what agents actually type; everything else passes by design.
- **Owner is a directory, not an allow-list of sessions.** The session's root directory is the only
  identity OpenCode gives a plugin reliably, and "rooted in the owning project" is exactly the rule
  being enforced.
- **Refusal text addressed to the model.** The error is read by the agent, so it tells the agent what
  to do (report, do not work around); `message` lets you make that protocol specific.
- **Empty default guards.** The plugin ships with no opinion about which directories are protected;
  loading it without options is a no-op so it can be installed before being configured.
- **`import type` for the plugin API.** Keeps the plugin free of runtime dependencies and loadable from
  a directory that has no `node_modules`.

## Current scope and non-goals

Today the guard covers the OpenCode tools `edit`, `write`, `patch`, `shell` and `bash` and the shell
constructs listed above. It is a guardrail that makes agents report instead of write; it is not a
sandbox and does not try to stop a deliberately evasive command. Other tools (MCP tools, custom tools)
are not inspected.

## Operations

- **Logs:** everything goes to the OpenCode server's stderr with the `[project-guard]` prefix — one
  line per refusal, one per internal fault, and one per allowed call when `debug` is on.
- **Health:** there is no state to check; if the plugin failed to load, OpenCode reports it at location
  boot and no `[project-guard]` lines appear.
- **Upgrade:** `git pull` in the plugin directory, then start a new session in each location (plugins
  are loaded per location boot). Run `bun test` after pulling if you changed anything locally.
