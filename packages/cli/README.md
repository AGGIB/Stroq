# stroq

**Local action firewall for AI coding agents.** Stroq scans what your agent reads (files, web pages, MCP tool results, command output) for indirect prompt injection, taints the session when it finds instruction-like text, and deterministically blocks the dangerous follow-up actions an injected agent would take — outbound network commands, secret access, external git pushes, encoded execution, self-tampering. Everything runs locally; nothing is sent to a cloud.

Supported today: **Claude Code** (via native hooks).

## Install

```bash
npx @stroq/cli init    # in your project: writes .claude/settings.json hooks
npx @stroq/cli doctor  # check the installation
```

`init` writes hooks into the project's `.claude/settings.json` by default; pass `--user` to install into `~/.claude/settings.json` instead, or `--dry-run` to preview the change.

Prefer a persistent install? `npm install -g @stroq/cli` installs the `stroq` command globally — then run `stroq init` and `stroq doctor` directly.

## Commands

| Command                                  | What it does                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `stroq init [--user] [--dry-run]`        | Install hooks into `.claude/settings.json` (or `~/.claude/settings.json`) |
| `stroq hook claude-code`                 | Hook entrypoint (reads the event on stdin)                                |
| `stroq doctor`                           | Check Node version, rules, hooks, self-test                               |
| `stroq log [--count 20]`                 | Show recent audit entries                                                 |
| `stroq verify`                           | Verify the audit hash chain                                               |
| `stroq untaint [--session <id>] [--all]` | Clear a false-positive session's taint, or every session's                |

## Learn more

- Full documentation, architecture, and the demo: [github.com/AGGIB/stroq](https://github.com/AGGIB/stroq#readme)
- Report a security issue or a bypass: [SECURITY.md](https://github.com/AGGIB/stroq/blob/main/SECURITY.md)

License: Apache-2.0.
