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

**Fail-closed.** A missing binary, a spawn error, a non-zero exit, a timeout, an
aborted run or an unreadable answer all block the call, which is OpenClaw's own
policy for this hook. `after_tool_call` never throws — the tool has already run.

## Configuration

`plugins.entries.stroq.config` in `openclaw.json`:

| Key            | Default                            | What it does                                                                                                                                                                                                 |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stroqBin`     | `stroq.json`, else `stroq` on PATH | The Stroq binary to spawn. `STROQ_BIN` is read before `stroq.json`.                                                                                                                                          |
| `workspace`    | the Gateway's `process.cwd()`      | The project directory for the secret index and path rules, when a call carries no `cwd`.                                                                                                                     |
| `timeoutMs`    | `10000`                            | How long Stroq gets to answer before the call is blocked.                                                                                                                                                    |
| `askTimeoutMs` | `120000`                           | How long an approval prompt stays open.                                                                                                                                                                      |
| `logLevel`     | the Gateway's own                  | Declared for the plugin manager's UI; this entry logs at fixed levels (`warn` for a block or a suspect result, `info` for an approval, `debug` for a failed scan) and lets the Gateway's logger filter them. |

Set `plugins.entries.stroq.enabled` to `true`, and add `stroq` to `plugins.allow` if
an allowlist is configured. This directory has no dependencies and is plain ESM
JavaScript, so nothing is installed or built when it is linked.
