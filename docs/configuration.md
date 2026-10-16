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
        "debug": false
      }
    }
  ]
}
```

## Options

| key | default | meaning |
|---|---|---|
| `guards` | `[]` (plugin inert) | list of `{ owner, paths, message? }`; `~` expands in `owner` and `paths` |
| `guards[].owner` | — | directory of the owning project; a session whose root is under it is never blocked by this guard |
| `guards[].paths` | — | directories the guard protects; a target equal to or below any of them is guarded |
| `guards[].message` | generic text | protocol appended to the refusal; `{owner}`, `{target}`, `{tool}`, `{directory}` are substituted |
| `debug` | `false` | log every decision (allowed calls too), not only refusals |

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

## Logging

Every refusal is logged to the OpenCode server's stderr as
`[project-guard] refused <tool> <target> from <directory> (owner <owner>, session <id>)`. With
`debug: true`, allowed calls are logged as `[project-guard] allowed <tool> <targets> from <directory>`.
An internal fault is logged as `[project-guard] internal failure, letting <tool> through: …` and the
call proceeds.

## Caveats

- Without `guards` the plugin loads and does nothing.
- OpenCode loads plugins once per location boot; a location that is already running keeps the plugin
  set and options it started with. Create a new session in that directory (or restart the server) to
  pick up a changed configuration.
- The shell parser is deliberately conservative: constructs it does not understand (`$(…)`,
  heredocs, variables in paths, scripts invoked by name) pass. The guard is a guardrail for agents,
  not a sandbox; see [SDD.md](SDD.md) for what is detected.
- Paths are compared after `realpath`, so a symlinked checkout and its target count as the same place.
