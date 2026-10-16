# Configuration

All options live in the plugin's `plugins[]` entry in `opencode.jsonc`:

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
            "message": "Infra is changed only from {owner}. Describe what you need to the user instead."
          }
        ],
        "rules": [
          {
            "id": "no-self-upgrade",
            "tools": ["shell", "bash"],
            "match": ["/\\bopencode\\s+upgrade\\b/i"],
            "message": "The opencode binary is updated by the release pipeline. Report to the user instead."
          }
        ],
        "debug": false
      }
    }
  ]
}
```

## Options

| key | default | meaning |
|---|---|---|
| `guards` | `[]` | list of `{ owner, paths, message? }`; `~` expands in `owner` and `paths` |
| `guards[].owner` | — | directory of the owning project; a session whose root is under it is never blocked by this guard |
| `guards[].paths` | — | directories the guard protects; a target equal to or below any of them is guarded |
| `guards[].message` | generic text | protocol appended to the refusal; `{owner}`, `{target}`, `{tool}`, `{directory}` are substituted |
| `rules` | `[]` | list of pattern rules, see [Rules](#rules) |
| `debug` | `false` | log every decision (allowed calls too), not only refusals and warnings |

With neither `guards` nor `rules` the plugin is inert.

Guards are validated when the plugin loads: an entry without a string `owner` or an array `paths` is
dropped, non-string entries in `paths` are ignored, and an empty `message` falls back to the generic
text. Several guards may be configured; the first guard whose paths match a target decides.

## The refusal

A refused call fails with a tool error of the form

```
[project-guard] `edit` refused: /home/me/dev/dns/zones.yaml is owned by the project at
/home/me/dev/infra, and this session is rooted at /home/me/dev/app. <message>
```

where `<message>` is the guard's `message` or, when none is set:

> Do not work around it. Changes to this territory are made only from a session rooted in the owning
> project (or through the API that project exposes); report what you needed to the user instead and
> let them decide. This call will not be accepted again from this session.

Use `message` to tell the model the concrete protocol for your setup (which API to call, where to
file a request, who decides).

## Rules

A rule matches regular expressions against the *subject fields* of a tool call and either refuses
the call or lets it run with a warning. Guards are evaluated first and are unaffected by rules; a call
a guard refuses never reaches the rules.

```jsonc
{
  "id": "slug",                  // required
  "kind": "refuse",              // refuse (default) | warn
  "tools": ["shell", "bash"],    // required
  "match": ["/pattern/flags"],   // string or array
  "except": ["/^rc\\.local$/"],  // optional
  "on": ["path"],                // optional
  "message": "…",                // required
  "allow_from": ["~/dev/x"],     // optional
  "unless_turn_tool": "question", // optional
  "unless_turn_tool_match": { … } // optional, exclusive with unless_turn_tool (see below)
}
```

| key | default | meaning |
|---|---|---|
| `id` | — (required) | slug naming the rule in refusals, warnings and logs |
| `kind` | `"refuse"` | `refuse`: the call fails with a tool error; `warn`: the call runs and the message is appended to its result |
| `tools` | — (required) | tool names the rule inspects (`shell`, `edit`, `execute`, an MCP tool name, …) |
| `match` | — (required) | one pattern or a list; `/body/flags` is a regular expression with flags, anything else is a plain pattern compiled without flags; the rule fires on the first pattern that matches any inspected field |
| `except` | none | patterns tested against the *matched text*; a match whose text matches any of them is ignored and the search continues |
| `on` | all fields of the tool | restricts which subject fields are inspected (see the table below) |
| `message` | — (required) | appended to the refusal or warning; `{id}`, `{tool}`, `{match}`, `{directory}`, `{subject}` are substituted |
| `allow_from` | none | directories (`~` expands); a session rooted at or below any of them skips the rule |
| `unless_turn_tool` | none | tool name; the rule passes when the current turn already contains a completed call of that tool |
| `unless_turn_tool_match` | none | `{ tool, answer, code, require? }`; the rule passes only when a completed call of `tool` in the current turn approved the same job the guarded call names (below) |

Rules are validated when the plugin loads: an entry without `id`, `tools` or `message`, or with a
pattern that does not compile, is dropped with a `[project-guard]` warning on stderr. The other rules
stay active.

### `unless_turn_tool_match`

| key | default | meaning |
|---|---|---|
| `tool` | — (required) | the approving tool, normally `question` |
| `answer` | — (required) | regex with at least one named group; run over every option label the user chose in a completed `tool` call of the turn, each match's named groups form one *approved job* |
| `code` | — (required) | object `key → regex`; every key must be a named group of `answer`; the regex extracts that key from the guarded call's matched subject field (named group of the same key, else group 1, else the whole match; first match, trimmed) |
| `require` | all keys of `code` | keys the guarded call must name; a missing one refuses with `code names no <key>` |

Only answers equal to one of the call's `options[].label` count; a typed answer never approves, even
when it contains the token. The chosen labels come from the completed part's `metadata.answers`,
with the result text parsed as a fallback. The rule passes when at least one approved job equals every
key extracted from the call (plain string compare: `340, 341` never equals `340`). Keys that are not
required and absent from the call are not compared.

Unlike `unless_turn_tool`, this condition **fails closed**: a failed context lookup, a guarded message
missing from the context or a turn without a completed `tool` call refuses, and the stderr line says
why. The refusal (or warning) text always ends with `Approval check: <detail>.`, where the detail is
`approved: file=340 plate=1 printer=1 copies=1; call names: file=341 printer=1`, `no completed question
in this turn`, `question answered but no approval token in the chosen option; call names: …`,
`code names no printer`, `session context unavailable` or `guarded message not found in the session
context`; `{detail}` in `message` substitutes the same text. A rule may carry either
`unless_turn_tool` or `unless_turn_tool_match`, not both.

The condition only sees the tool calls the plugin hooks. A shell command that reaches the same HTTP
API directly (`curl …`) is a `shell` call with a `command` subject, which an `execute` rule never
inspects: cover it with a separate `shell` rule or accept that it stays uncovered.

### Subject fields

| tool | fields |
|---|---|
| `shell`, `bash` | `command` — the command line, prefixed with `cd <workdir> && ` when the call has a `workdir` |
| `edit`, `write`, `patch` | `path` — the resolved absolute target paths, one per line; `content` — the text being written (`content`, `newString` or the patch text) |
| `execute` (Code Mode) | `code` — the JavaScript passed to the runtime |
| any other tool | `name` — the tool name; `input` — the input as JSON |

Because `path` holds one target per line, anchor path patterns with the `m` flag
(`/…\.ya?ml$/m`) when a patch can touch several files.

### Refusal and warning text

A refuse rule throws

```
[project-guard] rule `<id>` refused `<tool>`: matched "<text>" in <field>. <message>
```

A warn rule lets the call run and appends

```
[project-guard] rule `<id>` warning for `<tool>`: matched "<text>" in <field>. <message>
```

to the tool's result, so the model reads it next to the output. Warnings are only added to calls that
completed; a failed call gets none. When several rules match, the first refuse rule in configuration
order decides; the warnings of every matching warn rule are appended.

### Examples

(a) Refuse a shell command:

```jsonc
{
  "id": "no-self-upgrade",
  "tools": ["shell", "bash"],
  "match": ["/\\bopencode\\s+upgrade\\b/i", "/opencode\\.ai\\/install/i"],
  "message": "The opencode binary is updated by the release pipeline. Report to the user instead."
}
```

(b) Refuse a hostname pattern in commands and in written file content, with an exception:

```jsonc
{
  "id": "no-dot-local",
  "tools": ["shell", "bash", "edit", "write", "patch"],
  "match": ["/(?<![\\w.\\/~-])[a-z0-9-]+\\.local\\b(?![\\w.-])/i"],
  "except": ["/^rc\\.local$/"],
  "message": "`.local` hostnames are not resolved here; use `<name>.home.internal` instead."
}
```

Without `on`, the rule inspects `command` for shell tools and both `path` and `content` for file
tools; `rc.local` is a file name, not a host, so `except` lets it pass.

(c) Refuse a Code Mode call unless the user approved it in this turn:

```jsonc
{
  "id": "print-approval",
  "tools": ["execute"],
  "match": ["/\\b(start_print|add_to_queue)\\b/"],
  "unless_turn_tool": "question",
  "message": "Starting a print on the 3D-printer API needs the user's approval via the question tool in this turn. Ask first."
}
```

(c′) The same, but only for the job the user approved — the agent puts a token in the option label
(`Print [print file=340 plate=1 printer=1 copies=1]`) and the call must name the same ids:

```jsonc
{
  "id": "print-approval",
  "tools": ["execute"],
  "match": ["/\\b(print_library_file|add_files_to_queue)\\b/"],
  "unless_turn_tool_match": {
    "tool": "question",
    "answer": "/\\[print file=(?<file>\\d+) plate=(?<plate>\\d+|-) printer=(?<printer>\\d+) copies=(?<copies>\\d+)\\]/",
    "code": {
      "file": "/\\bfile_ids?\\b\\W{0,4}(\\d+(?:\\s*,\\s*\\d+)*)/",
      "printer": "/\\bprinter_id\\b\\W{0,3}(\\d+)/",
      "plate": "/\\bplate_(?:id|index|number|idx)\\b\\W{0,3}(\\d+)/",
      "copies": "/\\b(?:copies|quantity|qty)\\b\\W{0,3}(\\d+)/"
    },
    "require": ["file", "printer"]
  },
  "message": "Starting a print needs the user's approval of that exact job in this turn. Ask first."
}
```

(d) Warn on compose-file edits from outside the owner project:

```jsonc
{
  "id": "compose-reminder",
  "kind": "warn",
  "tools": ["edit", "write", "patch"],
  "on": ["path"],
  "match": ["/(^|\\/)(docker-)?compose[\\w.-]*\\.ya?ml$/m"],
  "allow_from": ["~/dev/infra"],
  "message": "If this service is managed by the service orchestrator, change it through its API instead."
}
```

## Logging

Every guard refusal is logged to the OpenCode server's stderr as
`[project-guard] refused <tool> <target> from <directory> (owner <owner>, session <id>)`. Rules log
`[project-guard] refused <tool> by rule <id> from <directory> (session <id>)` and
`[project-guard] warned <tool> by rule <id> from <directory>`; a rule dropped at load logs why. With
`debug: true`, allowed calls are logged as `[project-guard] allowed <tool> <targets> from <directory>`.
An internal fault is logged as `[project-guard] internal failure, letting <tool> through: …` and the
call proceeds.

## Caveats

- Without `guards` or `rules` the plugin loads and does nothing.
- OpenCode loads plugins once per location boot; a location that is already running keeps the plugin
  set and options it started with. Create a new session in that directory (or restart the server) to
  pick up a changed configuration.
- The shell parser is deliberately conservative: constructs it does not understand (`$(…)`,
  heredocs, variables in paths, scripts invoked by name) pass. The guard is a guardrail for agents,
  not a sandbox; see [SDD.md](SDD.md) for what is detected.
- Paths are compared after `realpath`, so a symlinked checkout and its target count as the same place.
- Rule patterns are JSON strings, so every regex backslash is doubled: `\b` is written `"\\b"`, a
  literal dot `"\\."`, a slash inside `/…/` `"\\/"`.
- `unless_turn_tool` fails open: when the session context cannot be read, the rule passes. It only
  checks that such a call completed in the current turn, not what it was about; use
  `unless_turn_tool_match` for the latter, which fails closed instead.
- Rules see the tool input as the model wrote it. A command assembled at runtime (variables, `$(…)`,
  a script file) is not expanded, so a rule can be evaded deliberately; it catches what agents
  actually type.
