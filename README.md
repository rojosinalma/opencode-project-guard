# opencode-project-guard

[![run-tests](https://github.com/rojosinalma/opencode-project-guard/actions/workflows/run-tests.yml/badge.svg)](https://github.com/rojosinalma/opencode-project-guard/actions/workflows/run-tests.yml)
[![release](https://img.shields.io/github/v/release/rojosinalma/opencode-project-guard)](https://github.com/rojosinalma/opencode-project-guard/releases)
[![license](https://img.shields.io/github/license/rojosinalma/opencode-project-guard)](LICENSE)

An [OpenCode](https://opencode.ai) plugin that refuses file and shell writes into another project's
territory. A guard names an *owner* directory and the *paths* it owns; a session rooted under the
owner passes, every other session gets a refusal when `edit`/`write`/`patch` target a guarded path or
a shell command would write there. Reads always pass, and when the shell parser is unsure the call
passes too — false negatives are acceptable, false positives are not. Next to guards, *rules* match
regular expressions against a tool call's command, paths, written content or Code Mode code and
either refuse the call or let it run with a warning appended, so a house rule can be enforced by code
instead of by prose. Any internal fault is logged and lets the call through, so the guard can never
break a session.

Configuration and design are documented in [docs/](docs/).

## Requirements

- [OpenCode](https://opencode.ai) ≥ 2.0 (plugin API `@opencode/plugin` 2.x)
- [Bun](https://bun.sh) ≥ 1.4 (the runtime OpenCode loads plugins with)

The plugin has no runtime dependencies; `@opencode/plugin` is imported as types only.

## Installation

Clone into the global plugins directory and configure your guards in `opencode.jsonc`:

```sh
git clone https://github.com/rojosinalma/opencode-project-guard ~/.config/opencode/plugins/project-guard
```

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/project-guard",
      "options": {
        "guards": [
          {
            "owner": "~/dev/infra",
            "paths": ["~/dev/infra", "~/dev/dns", "~/dev/proxy"],
            // optional: replaces the generic "what to do instead" part of the refusal
            "message": "Infra is changed only from ~/dev/infra. Describe what you need to the user instead."
          }
        ],
        "rules": [
          {
            "id": "no-self-upgrade",
            "tools": ["shell", "bash"],
            "match": ["/\\bopencode\\s+upgrade\\b/i"],
            "message": "The opencode binary is updated by the release pipeline. Report to the user instead."
          },
          {
            "id": "compose-reminder",
            "kind": "warn",
            "tools": ["edit", "write", "patch"],
            "on": ["path"],
            "match": ["/(^|\\/)(docker-)?compose[\\w.-]*\\.ya?ml$/m"],
            "allow_from": ["~/dev/infra"],
            "message": "If this service is managed by the service orchestrator, change it through its API instead."
          }
        ]
      }
    }
  ]
}
```

Without `guards` or `rules` the plugin loads and does nothing. All options are described in
[docs/configuration.md](docs/configuration.md).

## Usage

Nothing to run: once a guard is configured, every new session enforces it. A session rooted outside
the owner that asks to edit `~/dev/dns/zones.yaml` gets a tool error such as

```
[project-guard] `edit` refused: /home/me/dev/dns/zones.yaml is owned by the project at
/home/me/dev/infra, and this session is rooted at /home/me/dev/app. …
```

and the same line lands on the OpenCode server's stderr. Set `guards[].message` to tell the model
what to do instead (which API to call, where to file a request), and `"debug": true` to log allowed
calls as well.

Rules are checked after the guards. A refuse rule fails the call with the rule's message; a warn rule
lets it run and appends the message to the tool's result. `opencode upgrade` with the rule above gives

```
[project-guard] rule `no-self-upgrade` refused `shell`: matched "opencode upgrade" in command. The
opencode binary is updated by the release pipeline. Report to the user instead.
```

### Approval of the exact job

`unless_turn_tool` only checks that *some* call of a tool (usually `question`) completed in the current
turn. `unless_turn_tool_match` checks *what was approved*: the rule passes only when the option label
the user chose carries a token describing the same job the guarded call names.

```jsonc
{
  "id": "print-approval",
  "tools": ["execute"],
  "match": ["/\\b(print_library_file|add_files_to_queue)\\b/"],
  "unless_turn_tool_match": {
    "tool": "question",
    // run over the chosen option labels; the named groups describe one approved job
    "answer": "/\\[print file=(?<file>\\d+) plate=(?<plate>\\d+|-) printer=(?<printer>\\d+) copies=(?<copies>\\d+)\\]/",
    // the same keys, extracted from the guarded call's subject (the Code Mode `code` here)
    "code": {
      "file": "/\\bfile_ids?\\b\\W{0,4}(\\d+(?:\\s*,\\s*\\d+)*)/",
      "printer": "/\\bprinter_id\\b\\W{0,3}(\\d+)/",
      "plate": "/\\bplate_(?:id|index|number|idx)\\b\\W{0,3}(\\d+)/",
      "copies": "/\\b(?:copies|quantity|qty)\\b\\W{0,3}(\\d+)/"
    },
    "require": ["file", "printer"] // keys the call must name; default: every key of `code`
  },
  "message": "Starting a print needs the user's approval of that exact job in this turn. Ask first."
}
```

The agent puts the token in an option label (`Print [print file=340 plate=1 printer=1 copies=1]`);
only a chosen *option label* approves, a typed answer never does. Every key the call names must equal
the approved job's value, so `file_ids: [340, 341]` is refused against an approval for `340`. The
refusal ends with `Approval check: approved: file=340 …; call names: file=341 …` (or `no completed
question in this turn`, `code names no printer`, …), also available as `{detail}` in the message.

This condition **fails closed**: when the session context cannot be read, the guarded message is not
found or no call of the tool completed in the turn, the call is refused. And it only covers tool calls
the plugin sees: a `curl` from a shell to the same HTTP API is a `shell` call whose command text this
rule never inspects, so either add a separate `shell` rule for it or accept that it stays uncovered.

## Development

```sh
bun install
bun test
```

There is no build step: `index.ts` is loaded by OpenCode as is. See [CONTRIBUTING.md](CONTRIBUTING.md)
for the layout, the test conventions and how to try a change against a live server.

## License

[AGPL-3.0](LICENSE) — Copyright (C) 2026 rojosinalma.
