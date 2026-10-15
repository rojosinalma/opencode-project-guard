# opencode-project-guard

An [OpenCode](https://opencode.ai) plugin that refuses file and shell writes into another project's
territory. A guard names an *owner* directory and the *paths* it owns; a session rooted under the
owner passes, every other session gets a refusal when `edit`/`write`/`patch` target a guarded path or
a shell command would write there. Reads always pass, and when the shell parser is unsure the call
passes too — false negatives are acceptable, false positives are not. Any internal fault is logged and
lets the call through, so the guard can never break a session.

## Install

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
        ]
      }
    }
  ]
}
```

No runtime dependencies (`@opencode/plugin` is imported as types only).

## Options

| key | default | meaning |
|---|---|---|
| `guards` | `[]` (plugin inert) | list of `{ owner, paths, message? }`; `~` expands in `owner` and `paths` |
| `guards[].message` | generic text | protocol appended to the refusal; `{owner}`, `{target}`, `{tool}`, `{directory}` are substituted |
| `debug` | `false` | log every decision |

## How it works

1. `tool.hook("execute.before")` on `edit`/`write`/`patch` resolves the target path (patches are parsed for theirs) and compares it with the guarded roots.
2. On `shell`/`bash` a conservative write-intent parser looks at redirections, `tee`, `sed -i`, `rm/mv/cp/mkdir/touch/chmod`, `git -C <dir> add|commit|…`, `docker compose -f <file>|cwd up|down|restart|…`; `cd` updates the cwd per `&&`/`;`/`|` segment. `git log/diff/status` and `compose logs/ps` pass.
3. A refusal is thrown as the tool error: what was refused and why, then the guard's `message` or a generic "change it from the owning project, report to the user" instruction.

## Tests

```sh
bun test
```

## Caveats

- Without `guards` the plugin loads and does nothing.
- Loaded per location boot; running locations keep the plugin set they started with.
