<p align="center">
  <img src="https://raw.githubusercontent.com/AGGIB/Stroq/main/docs/assets/logo.svg" alt="Stroq" width="280">
</p>

<p align="center">
  <a href="https://github.com/AGGIB/Stroq/actions/workflows/ci.yml"><img src="https://github.com/AGGIB/Stroq/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@stroq/cli"><img src="https://img.shields.io/npm/v/%40stroq%2Fcli?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@stroq/cli"><img src="https://img.shields.io/npm/d18m/%40stroq%2Fcli?label=downloads&color=0b7285" alt="npm downloads"></a>
  <a href="https://github.com/AGGIB/Stroq/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

**Local action firewall for AI coding agents.** Stroq scans what your agent reads (files, web pages, MCP tool results, command output) for indirect prompt injection, taints the session when it finds instruction-like text, and deterministically blocks the dangerous follow-up actions an injected agent would take — outbound network commands, secret access, external git pushes, encoded execution, self-tampering. Everything runs locally; nothing is sent to a cloud.

Supported today: **Claude Code**, **Cursor**, **Codex**, **Copilot CLI**, **Windsurf** (native hooks) · **OpenClaw** (in-process plugin).

## Install

```bash
npx @stroq/cli init                  # Claude Code: writes .claude/settings.json hooks
npx @stroq/cli init --agent cursor   # Cursor: writes .cursor/hooks.json
npx @stroq/cli init --agent codex    # Codex CLI: writes .codex/hooks.json
npx @stroq/cli init --agent copilot  # Copilot CLI: writes .github/hooks/stroq.json
npx @stroq/cli init --agent openclaw # OpenClaw: installs a plugin into ~/.stroq/openclaw-plugin
npx @stroq/cli init --agent windsurf # Windsurf: merges into .windsurf/hooks.json
npx @stroq/cli doctor                # check the installation
```

`init` writes hooks into the project's `.claude/settings.json` by default; pass `--user` to install into `~/.claude/settings.json` instead, or `--dry-run` to preview the change.

Prefer a persistent install? `npm install -g @stroq/cli` installs the `stroq` command globally — then run `stroq init` and `stroq doctor` directly.

## Commands

| Command                                            | What it does                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `stroq init [--agent <name>] [--user] [--dry-run]` | Install hooks for `claude-code`, `cursor`, `codex`, `copilot`, `openclaw` or `windsurf` (`--user` for the home-directory copy) |
| `stroq hook <agent>`                               | Hook entrypoint (reads the event on stdin; `copilot` and `openclaw` take a `pre`/`post` argument, the others do not)           |
| `stroq doctor`                                     | Check Node version, rules, hooks for every agent, self-test                                                                    |
| `stroq log [--count 20]`                           | Show recent audit entries                                                                                                      |
| `stroq verify`                                     | Verify the audit hash chain                                                                                                    |
| `stroq untaint [--session <id>] [--all]`           | Clear a false-positive session's taint and provenance, or every session's                                                      |
| `stroq why [--seq <n>]`                            | Explain the most recent denied/asked action: rule, provenance, taint                                                           |

## Learn more

- Full documentation, architecture, and the demo: [github.com/AGGIB/Stroq](https://github.com/AGGIB/Stroq#readme)
- Report a security issue or a bypass: [SECURITY.md](https://github.com/AGGIB/Stroq/blob/main/SECURITY.md)

License: Apache-2.0.
