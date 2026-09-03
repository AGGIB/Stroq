# Stroq

**Local action firewall for AI agents.** Stroq scans what your coding agent reads (files, web pages, MCP tool results, command output) for indirect prompt injection, taints the session when it finds instruction-like text, and deterministically blocks the dangerous follow-up actions an injected agent would take: outbound network commands, secret access, external git pushes, encoded execution, self-tampering. Everything runs locally in a few milliseconds; nothing is sent to a cloud.

Supported today: **Claude Code** (via native hooks). Cursor, Codex, Copilot, Windsurf and OpenClaw adapters are next.

## Quick start (Claude Code)

```bash
pnpm install && pnpm build            # from this repo (npm package coming)
node packages/cli/dist/index.js init  # in your project: writes .claude/settings.json hooks
node packages/cli/dist/index.js doctor
```

Then open Claude Code in that project. Try it on the poisoned demo: `./examples/demo/run-demo.sh`.

## How it works

1. **PostToolUse**: the output of `Read`, `WebFetch`, `WebSearch`, `Bash`, `Grep` and every `mcp__*` tool is normalized (zero-width characters, homoglyphs, base64/hex/url decoding up to two levels) and matched against ATR-format rules. A suspicious result marks the session as tainted and warns the agent.
2. **PreToolUse**: `Bash`, `Write`/`Edit`, `Read`, `WebFetch` and `mcp__*` calls are classified into action classes (`shell.network`, `shell.destructive`, `shell.exec_encoded`, `fs.secrets`, `git.push_external`, `config.self`, `mcp.side_effect`, …) and evaluated against the policy. Tainted sessions get `deny` on network/secret/push actions; destructive commands always `ask`; encoded execution and self-tampering are always denied.
3. **Audit**: every decision is appended to a hash-chained JSONL log (`~/.stroq/audit.jsonl`). `stroq verify` proves it has not been edited. A false positive can be cleared with `stroq untaint --session <id>` (the session id is shown in `stroq log`).

If Stroq itself crashes while handling a high-impact tool call, it fails **closed** (deny) rather than silently allowing the action.

## Commands

| Command                                  | What it does                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `stroq init [--user] [--dry-run]`        | Install hooks into `.claude/settings.json` (or `~/.claude/settings.json`) |
| `stroq hook claude-code`                 | Hook entrypoint (reads the event on stdin)                                |
| `stroq doctor`                           | Check Node version, rules, hooks, self-test                               |
| `stroq log [--count 20]`                 | Show recent audit entries                                                 |
| `stroq verify`                           | Verify the audit hash chain                                               |
| `stroq untaint [--session <id>] [--all]` | Clear a false-positive session's taint, or every session's                |

## Policy

Copy `policies/default.yaml` to `~/.stroq/policy.yaml` and edit. Rules are evaluated in order; the first match wins. Set `STROQ_HOME` to relocate all state.

## Rules

Our rules live in `rules/stroq/` (ATR format, Apache-2.0). `rules/atr/` vendors categories from [Agent Threat Rules](https://github.com/Agent-Threat-Rule/agent-threat-rules) (MIT). Any vendored rule that fires on `rules/fixtures/benign/` is disabled automatically at build time (`pnpm build:rules`) — false positives are treated as bugs. A Stroq-authored rule is held to the same bar but is never auto-disabled: a false positive on the benign corpus fails the build instead, so we fix the rule.

## Development

```bash
pnpm test:coverage   # vitest, 80% threshold
pnpm typecheck
pnpm build
```

License: Apache-2.0.
