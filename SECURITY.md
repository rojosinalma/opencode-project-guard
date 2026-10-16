# Security policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/rojosinalma/opencode-project-guard/security/advisories/new)
(the Security tab of this repository). Do not open a public issue. You will get an acknowledgement
within a week and a fix or a statement before any public disclosure.

## Supported versions

Only the latest release receives fixes. Update your clone to the newest `vX.Y.Z` tag before reporting.

## What the plugin does and does not do

The guard is a guardrail for an agent, not a security boundary for a host:

1. It runs inside the OpenCode server with that process's permissions and inspects tool calls only.
   It cannot stop a process the agent already started, a write performed by a sub-process or a
   command the shell parser does not recognise — by design an unrecognised command passes.
2. It reads no secrets, keeps no state and makes no network requests. Refusals are logged to the
   server's stderr with the target path, the session directory and the session id.
3. A bypass of the parser (a write that reaches a guarded path without a refusal) is a bug worth a
   report, but treat the guard as a safety net: file permissions and the OpenCode permission system
   remain the hard limits.
