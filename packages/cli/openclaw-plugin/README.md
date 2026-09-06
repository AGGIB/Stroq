# Stroq plugin for OpenClaw

A thin gate that forwards every tool call to the Stroq CLI and does what it says.
It is shipped inside `@stroq/cli`; `stroq init --agent openclaw` copies it to
`$STROQ_HOME/openclaw-plugin/` (default `~/.stroq/openclaw-plugin/`), writes a
`stroq.json` recording how to start Stroq, and then runs — or prints — these two:

    openclaw plugins install --link ~/.stroq/openclaw-plugin
    openclaw plugins enable stroq

Restart the Gateway afterwards: plugins are loaded when it starts.

## Hooks

- `before_tool_call` (priority 100, no matcher) runs `stroq hook openclaw pre`.
  `allow` returns nothing, `deny` blocks with the rule and reason, `ask` raises a
  `requireApproval` prompt answered with `/approve <id> allow-once|deny`.
- `after_tool_call` runs `stroq hook openclaw post`, which scans the result, records
  provenance and taints the session. It is observe-only: the warning is logged, the
  taint is enforced on the next tool call.

**Fail-closed.** Every one of these blocks the call, which is OpenClaw's own policy
for this hook: a missing binary, a spawn error, a non-zero exit, a timeout, an aborted
run, a reply larger than 1 MiB (a hung CLI, not a decision), params that cannot be
serialised, stdout that is not JSON or is JSON but not an object, and a decision this
plugin does not know. `after_tool_call` never throws — the tool has already run — and
a scan that fails there is logged at `warn`, since a failed scan means no taint.

If the `stroq.json` `init` recorded points at an entry that no longer exists (an npx
cache that has since been pruned), the plugin logs one warning and falls back to
`stroq` on PATH rather than blocking every call on the same ENOENT. When there is no
Stroq on PATH either, the call still fails closed.

## Configuration

`plugins.entries.stroq.config` in `openclaw.json`. It is read **once**, when the
plugin registers, so restart the Gateway after changing any of it:

| Key            | Default                            | What it does                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroqBin`     | `stroq.json`, else `stroq` on PATH | Path to the Stroq binary to spawn, as one string (never split on spaces, and never existence-checked — a binary you named must fail loudly rather than be silently replaced). `STROQ_BIN` is read before `stroq.json`, and a `stroq.json` whose recorded entry file is gone is skipped in favour of PATH. A launch command needing extra arguments belongs in `stroq.json`'s `command` array instead. |
| `workspace`    | the Gateway's `process.cwd()`      | The project directory for the secret index and path rules. A tool call's own `params.cwd` is never used for this, for any tool including `exec`: honouring one would let an agent point it at an empty directory and slip past a secret-egress guard.                                                                                                                                                 |
| `timeoutMs`    | `10000`                            | How long Stroq gets to answer before the call is blocked.                                                                                                                                                                                                                                                                                                                                             |
| `askTimeoutMs` | `120000`                           | How long an approval prompt stays open, clamped to OpenClaw's documented 1 000–600 000 ms range.                                                                                                                                                                                                                                                                                                      |
| `logLevel`     | the Gateway's own                  | Declared for the plugin manager's UI; this entry logs at fixed levels (`warn` for a block, a suspect result, a failed post scan or a stale `stroq.json`, `info` for an approval resolution) and lets the Gateway's logger filter them.                                                                                                                                                                |

Set `plugins.entries.stroq.enabled` to `true`, and add `stroq` to `plugins.allow` if
an allowlist is configured. This directory has no dependencies and is plain ESM
JavaScript, so nothing is installed or built when it is linked.
