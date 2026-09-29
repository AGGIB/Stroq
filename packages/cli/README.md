<p align="center">
  <img src="https://raw.githubusercontent.com/AGGIB/Stroq/main/docs/assets/logo.svg" alt="Stroq" width="280">
</p>

<p align="center">
  <a href="https://github.com/AGGIB/Stroq/actions/workflows/ci.yml"><img src="https://github.com/AGGIB/Stroq/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@stroq/cli"><img src="https://img.shields.io/npm/v/%40stroq%2Fcli?logo=npm&logoColor=white&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@stroq/cli"><img src="https://img.shields.io/npm/d18m/%40stroq%2Fcli?label=downloads&color=0b7285" alt="npm downloads"></a>
  <a href="https://github.com/AGGIB/Stroq/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="License: Apache 2.0"></a>
</p>

# Stroq — find known secrets in AI coding-agent sessions

**Check a session you already ran:** `stroq sent` looks for exact matches to credentials currently available on your machine in local Claude Code, Codex CLI and Cursor session records. It reports the credential name, source file and recorded tool call without printing the value. A match proves that the value appears in a local record; it does not prove that a model provider received it, that the credential is still valid or that a breach occurred.

```bash
npx @stroq/cli sent --last       # inspect the newest supported session in this project
npx @stroq/cli replay --last     # trace recorded content to later agent actions
```

What a finding looks like (a synthetic session, trimmed):

```text
stroq sent — credential evidence in recorded agent sessions

✗ 1 known credential value(s) in this session's recorded tool calls: aws_secret_access_key

CREDENTIAL VALUES FOUND IN THIS SESSION RECORD (1)

  ● aws_secret_access_key — ~/.aws/credentials
      seen once, first at 2026-09-28T10:00:01Z
      └─ in the result of    Read       ~/.aws/credentials

NEXT
  Rotate each credential named above that is still live.
    aws_secret_access_key: https://console.aws.amazon.com/iam/home#/security_credentials
```

Run these commands from the project directory with Node.js 22 or newer. They work on sessions from before Stroq was installed. `npx` downloads the CLI from npm; `sent` reads local credential sources to know what values to match and does not upload them. See the [guide's coverage and limits](https://github.com/AGGIB/Stroq/blob/main/docs/GUIDE.md).

**Guard future sessions:** Stroq scans content visible to installed agent hooks, carries suspicion and source information into later decisions, and applies a local policy to the tool calls those hooks expose. It supports native hooks, an OpenClaw plugin and a stdio MCP proxy; coverage differs by agent and channel. The hooks do not send telemetry.

Supported today: **Claude Code**, **Cursor**, **Codex**, **Copilot CLI**, **Windsurf**, **Google Antigravity** (native hooks) · **OpenClaw** (in-process plugin) · **any MCP client** (stdio proxy).

## Install

```bash
npx @stroq/cli init                  # Claude Code: writes .claude/settings.json hooks
npx @stroq/cli init --agent cursor   # Cursor: writes .cursor/hooks.json
npx @stroq/cli init --agent codex    # Codex CLI: writes .codex/hooks.json
npx @stroq/cli init --agent copilot  # Copilot CLI: writes .github/hooks/stroq.json
npx @stroq/cli init --agent openclaw # OpenClaw: installs a plugin into ~/.stroq/openclaw-plugin
npx @stroq/cli init --agent windsurf # Windsurf: merges into .windsurf/hooks.json
npx @stroq/cli init --agent antigravity # Google Antigravity: merges into .agents/hooks.json
npx @stroq/cli init --agent mcp --client claude-desktop   # any MCP client: wraps its stdio servers
npx @stroq/cli doctor                # check the installation
```

`init` writes hooks into the project's `.claude/settings.json` by default; pass `--user` to install into `~/.claude/settings.json` instead, or `--dry-run` to preview the change.

Prefer a persistent install? `npm install -g @stroq/cli` installs the `stroq` command globally — then run `stroq init` and `stroq doctor` directly.

Windsurf note: `post_read_code` cannot scan a directory Cascade reads recursively (it scans the file it names, and a directory reads as empty), and a tainted `pre_read_code` of `~/.ssh` or `~/.aws` without a trailing slash is not classified as a secret path either — see the [Windsurf section of the full README](https://github.com/AGGIB/Stroq/blob/main/docs/AGENTS.md#windsurf) for this and every other documented limit.

MCP proxy note: for clients with no hook API, `--agent mcp` rewrites the client's `mcpServers` entries so each stdio server starts through `stroq mcp`, which judges every `tools/call` and scans every result. There is no way to prompt from inside a proxy, so a policy `ask` arrives as a blocked tool result naming the rule; HTTP (`url`/`serverUrl`) servers are skipped; and the project directory is the one `init` ran in — see the [MCP proxy section of the full README](https://github.com/AGGIB/Stroq/blob/main/docs/AGENTS.md#mcp-proxy-any-mcp-client) for this and every other documented limit.

## Commands

| Command                                                 | What it does                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroq init [--agent <name>] [--user] [--dry-run]`      | Install hooks for `claude-code`, `cursor`, `codex`, `copilot`, `openclaw`, `windsurf` or `antigravity`, or wrap an MCP client's stdio servers with `--agent mcp --client <name>` or `--config <path>` (`--user` for the home-directory copy) |
| `stroq uninstall [--agent <name>] [--user] [--dry-run]` | Take Stroq's hooks out of an agent's config, leaving everything else as it was                                                                                                                                                               |
| `stroq hook <agent>`                                    | Hook entrypoint (reads the event on stdin; `copilot` and `openclaw` take a `pre`/`post` argument, the others do not)                                                                                                                         |
| `stroq mcp --server <name> -- <cmd>`                    | MCP stdio proxy: judges every `tools/call` and scans every result for one wrapped server                                                                                                                                                     |
| `stroq doctor`                                          | Check Node version, rules, hooks for every agent, self-test                                                                                                                                                                                  |
| `stroq log [--count 20] [--json]`                       | Show recent audit entries; `--json` prints one entry per line                                                                                                                                                                                |
| `stroq verify`                                          | Verify the audit hash chain                                                                                                                                                                                                                  |
| `stroq untaint [--session <id>] [--all]`                | Clear a false-positive session's taint and provenance, or every session's                                                                                                                                                                    |
| `stroq why [--seq <n>]`                                 | Explain the most recent denied/asked action: rule, provenance, taint                                                                                                                                                                         |
| `stroq sent [--last] [--transcript <path>] [--json]`    | Match known local credentials against a recorded session, including tool results where a transcript is available; report names and sources, never values                                                                                     |
| `stroq replay [--last] [--transcript <path>] [--json]`  | Reconstruct which recorded content preceded later agent actions and show the matching evidence                                                                                                                                               |
| `stroq canary [--name <NAME>] [--file <path>]`          | Print a canary secret to plant; its outbound use is denied and taints the session. `--file` plants it as a decoy file: any call naming the file is denied and taints the session                                                             |
| `stroq attack [--json] [--only <id>] [--fuzz]`          | Replay 21 documented-incident and synthetic scenarios against your policy; `--fuzz` crosses each with a deterministic mutation set and reports variants that reach `allow`; exit 1 if any gets through                                       |
| `stroq exposure [--probe] [--share] [--json]`           | Map this machine's agent surface and report what reaches you; exit 1 on any finding                                                                                                                                                          |
| `stroq bench [--corpus <dir>] [--json] [--verbose]`     | Measure the shipped rule set's false-positive rate against a corpus of benign developer documentation; `--verbose` lists the flagged files                                                                                                   |
| `stroq coverage [--format <table\|navigator>] [--json]` | Print the control mapping against MITRE ATLAS and OWASP ASI, built from the attack corpus's own scenario tags; `--format=navigator` emits an ATT&CK Navigator layer                                                                          |

`stroq exposure` reads files only. `--probe` is the one flag that starts a process: it launches each configured stdio MCP server, asks once for `tools/list`, scans the tool descriptions and shuts the server down — no tool is ever called. Without it, tool-description poisoning is not covered by the run, and the report says so. `--share` prints a redacted summary built from a whitelist, locally; nothing is transmitted.

The corpus `stroq bench` measures against ships with this repository, not with the npm package; on an installed CLI, point it at your own documentation with `stroq bench --corpus <dir>` — the published number in [`docs/BENCH.md`](https://github.com/AGGIB/Stroq/blob/main/docs/BENCH.md) is exactly that command run against the vendored corpus.

## Learn more

- Full documentation, architecture, and the demo: [github.com/AGGIB/Stroq](https://github.com/AGGIB/Stroq/blob/main/docs/GUIDE.md)
- Report a security issue or a bypass: [SECURITY.md](https://github.com/AGGIB/Stroq/blob/main/SECURITY.md)

License: Apache-2.0.
