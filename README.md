# opencode-project-guard

An [OpenCode](https://opencode.ai) plugin that refuses file and shell writes into another project's
territory. A guard names an *owner* directory and the *paths* it owns; a session rooted under the
owner passes, every other session gets a refusal when `edit`/`write`/`patch` target a guarded path or
a shell command would write there. Reads always pass, and when the shell parser is unsure the call
passes too — false negatives are acceptable, false positives are not. Any internal fault is logged and
lets the call through, so the guard can never break a session.

Configuration and design are documented in `docs/`.

## Requirements

- OpenCode 2.x running on Bun (the plugin API is `@opencode/plugin` 2.x).
- No runtime dependencies: `@opencode/plugin` is imported as types only.

## Setup

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

Without `guards` the plugin loads and does nothing. All options are described in
[docs/configuration.md](docs/configuration.md).

## License

MIT — see [LICENSE](LICENSE).
