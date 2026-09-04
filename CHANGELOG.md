# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-04

Initial public release.

### Added

- **Claude Code hook adapter** (`stroq hook claude-code`): handles `PostToolUse` and `PreToolUse` events for `Bash`, `Read`, `Write`/`Edit`, `WebFetch`, `WebSearch`, `Grep`, and every `mcp__*` tool.
- **Normalizer**: strips zero-width characters and tag/variation-selector code points, folds homoglyphs, and recursively decodes base64/hex/URL-encoded content up to two levels before scanning.
- **ATR-compatible rule engine**: loads and compiles [Agent Threat Rules](https://github.com/Agent-Threat-Rule/agent-threat-rules)-format YAML rules, including PCRE-to-`RegExp` translation, and matches them against normalized content.
- **Rules bundle**: 12 Stroq-authored rules (`rules/stroq/`, Apache-2.0) covering instruction override, hidden directives, secret exfiltration, encoded execution, and related prompt-injection patterns, plus vendored ATR categories (`rules/atr/`, MIT). Built with a benign-corpus false-positive gate and a regex performance gate (`pnpm build:rules`).
- **Action classifier**: classifies `Bash` commands and tool calls into action classes (`shell.network`, `shell.destructive`, `shell.exec_encoded`, `fs.secrets`, `git.push_external`, `config.self`, `config.self_touch`, `mcp.side_effect`, and more), including wrapper commands, encoded/`eval`'d execution, and self-tampering detection.
- **Taint-aware policy engine**: evaluates classified actions against an ordered, first-match policy (`policies/default.yaml`); tainted sessions get `deny` on network/secret/push actions, destructive commands always `ask`, encoded execution and proven self-tampering are always denied.
- **Session taint store**: file-locked, per-session taint state keyed by session id.
- **Hash-chained audit log** (`~/.stroq/audit.jsonl`): every decision is appended and chainable; `stroq verify` checks the chain for tampering; sensitive values are redacted before being written.
- **CLI commands**: `init` (installs hooks into `.claude/settings.json`, project or `--user`), `doctor` (checks Node version, rules, hooks, self-test), `log` (recent audit entries), `verify` (audit chain check), `untaint` (clears a false-positive session's taint).
- **Fail-closed behavior**: if Stroq crashes while handling a high-impact tool call, the action is denied rather than silently allowed.
- Working end-to-end demo (`examples/demo/`): a poisoned `README.md` taints the session, and the follow-up `curl | sh` command is denied.
