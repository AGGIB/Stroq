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

## MCP runtime pins

`stroq mcp --server <name> --client <client> --pin sha256:<64 lowercase hex> -- node <absolute store entrypoint> [server arguments]` refuses to start unless the same server name and digest are confirmed in this machine's `passports.json`. It checks every stored file against the `stroq-tree/1` manifest, reads the source bytes once, and launches those bytes from a fresh private directory under `<STROQ_HOME>/run` (owned by the current user, mode 0700 on POSIX). The copy is normally removed after the server exits, including shutdown through SIGINT, SIGTERM or SIGHUP; SIGKILL, a crash during preparation, or a filesystem cleanup error can leave a copy there. Remove leftovers only after their servers have stopped. Windows relies on the user's home-directory ACL; POSIX mode bits do not establish Windows ACL isolation.

The server's working directory is the private copy, so relative paths refer to the confirmed tree rather than the project. `--cwd` selects the project for Stroq's decisions only. Every whole absolute argument inside the store tree is relocated to the corresponding file or directory in the copy; embedded references such as `--config=<store tree>/config.json` are refused, so pass the path as a separate argument. The Node runtime is the one running Stroq; Node loader flags before the entrypoint, package runners such as `npx`, and entrypoints outside the store are refused. Pinned wrappers with no environment record use the filtered infrastructure environment. Repeated `--pin` flags and malformed pins are usage errors.

`stroq init --agent mcp` preserves existing `--pin` flags when it rewrites a wrapper, including invalid pins which must keep failing closed. Rewriters that use `wrapMcpConfig` inherit that behavior. `--unwrap` removes the pin along with the wrapper and prints a notice. `stroq doctor` checks each configured pin offline, and `stroq exposure` reports a changed or unverifiable pinned server as `mcp-pin-drifted`. Neither check starts the server.

The shared lock layout is `{ "v": 1, "skills": {}, "mcp": { "<server name>": { "kind": "mcp", "status": "confirmed", "digest": "<64 lowercase hex>", "grant": { "pin": "sha256:<same digest>" } } } }`. The `skills` and `mcp` buckets are intentional: their writers must preserve each other's records. The schema lives in `install/passports-schema.ts`, read through `install/lock-reader.ts` and shared with install writers; the lock reader refuses files over 4 MiB with a distinct size-limit diagnostic.

This is **tamper-evident, not tamper-proof**: the same user can change the store, lock or private copy. The pin covers the shipped tree of a self-contained Node server; a package absent from that tree can still be resolved from an ancestor's `node_modules` and is not covered by the pin. The private runtime folder prevents a module planted above a shared temporary copy from being used, but does not sandbox package resolution or the server, attest the Node executable, or cover code fetched at runtime. The pin itself is a flag in the client config: an agent able to edit `.mcp.json` or `.cursor/mcp.json` can remove it, and offline diagnostics inspect only entries that still carry a pin. The plain lock records neither who confirmed nor a signature. No Stroq command in this runtime implementation writes an MCP confirmation yet; a user must currently write that record by hand. MCP installation and its human-confirmation flow are a separate Safe Install task. A wrapper without `--pin` retains its existing behavior.

## Commands

| Command                                                                | What it does                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stroq init [--agent <name>] [--user] [--dry-run]`                     | Install hooks for `claude-code`, `cursor`, `codex`, `copilot`, `openclaw`, `windsurf` or `antigravity`, or wrap an MCP client's stdio servers with `--agent mcp --client <name>` or `--config <path>` (`--user` for the home-directory copy)                    |
| `stroq uninstall [--agent <name>] [--user] [--dry-run]`                | Take Stroq's hooks out of an agent's config, leaving everything else as it was                                                                                                                                                                                  |
| `stroq hook <agent>`                                                   | Hook entrypoint (reads the event on stdin; `copilot` and `openclaw` take a `pre`/`post` argument, `antigravity` takes `pre`, `post` or `preinvocation`, the others take none)                                                                                   |
| `stroq mcp --server <name> -- <cmd>`                                   | MCP stdio proxy: judges every `tools/call` and scans every result; an optional runtime pin checks locally confirmed server bytes before starting a private copy                                                                                                 |
| `stroq run [--agent <id>] -- <agent> …`                                | Start an agent already confined: sets the git settings that stop a repository running a command at startup, refuses to launch into one that runs something before you could approve it, and checks that Stroq's hooks are installed                             |
| `stroq run --sandbox -- <agent> …`                                     | With `srt` installed, also wrap the launch: credential files unreadable, network closed except `--allow-domain` hosts. Without `srt`, Stroq says so and starts the agent unwrapped                                                                              |
| `stroq doctor`                                                         | Check Node version, rules, hooks for every agent and when each last called Stroq, self-test                                                                                                                                                                     |
| `stroq prove [--agent <id>] [--yes] [--dry-run]`                       | Run the live protection check on Claude Code or Codex CLI: up to 3 short requests on your own login (no API key), asked first. Shows a denied command stopped with the hook and ran without it. Exit 0 verified, 1 failed, 3 else                               |
| `stroq log [--count 20] [--json]`                                      | Show recent audit entries; `--json` prints one entry per line                                                                                                                                                                                                   |
| `stroq verify`                                                         | Verify the audit hash chain                                                                                                                                                                                                                                     |
| `stroq untaint [--session <id>] [--all]`                               | Clear a false-positive session's taint and provenance, or every session's                                                                                                                                                                                       |
| `stroq trust [<file>] [--list] [--remove <file>]`                      | Waive a false positive on a file's exact content; any change to the file taints again. `--list`, or no argument, shows what is trusted; `--remove <file>` stops trusting a file                                                                                 |
| `stroq why [--seq <n>]`                                                | Explain the most recent denied/asked action: rule, provenance, taint                                                                                                                                                                                            |
| `stroq sent [--last] [--transcript <path>] [--json]`                   | Match known local credentials against a recorded session, including tool results where a transcript is available; report names and sources, never values                                                                                                        |
| `stroq replay [--last] [--transcript <path>] [--json]`                 | Reconstruct which recorded content preceded later agent actions and show the matching evidence                                                                                                                                                                  |
| `stroq canary [--name <NAME>] [--file <path>]`                         | Print a canary secret to plant; its outbound use is denied and taints the session. `--file` plants it as a decoy file: any call naming the file is denied and taints the session                                                                                |
| `stroq attack [--json] [--only <id>] [--fuzz]`                         | Replay 36 documented-incident and synthetic scenarios against your policy; `--fuzz` crosses each with a deterministic mutation set and reports variants that reach `allow`; exit 1 if any gets through                                                          |
| `stroq policy check [<file>] [--json]`                                 | Load a policy file as the hook does and list what is wrong: faults by field, a rule that can never match, a protection of the default policy it drops, `default: allow`, a high `threshold`. Exit 1 on a finding                                                |
| `stroq policy test [--policy <file>] [--cases <file>]`                 | Replay the attack corpus, ordinary work and your cases under a policy and a baseline (`--baseline`); print each step whose decision changed. Exit 1 if an attack passes or `--max-new-interruptions <n>` is exceeded                                            |
| `stroq exposure [--probe] [--share] [--json]`                          | Map this machine's agent surface and report what reaches you; exit 1 on any finding                                                                                                                                                                             |
| `stroq inspect [<dir>] [--json\|--sarif] [--env]`                      | Read what a repository runs before you open it with an agent; exit 1 when something runs before you could approve it. `--sarif` writes SARIF 2.1.0 for code scanning, `--env` prints the git settings that neutralise it                                        |
| `stroq vet (--from <dir or .tgz> \| --online <spec>) [--json\|--card]` | Read a skill, MCP server or plugin (folder, .tgz or online npm/GitHub source) before you add it, and print its passport: what it asks for or can do, and every blind spot. Reads, never runs. `--expect <sha256>` checks the digest. Not a security certificate |
| `stroq bench [--corpus <dir>] [--json] [--verbose]`                    | Measure the shipped rule set's false-positive rate against a corpus of benign developer documentation; `--verbose` lists the flagged files                                                                                                                      |
| `stroq bench --actions [--json]`                                       | Replay 75 scenarios of ordinary agent work against your policy and count how many it interrupts                                                                                                                                                                 |
| `stroq coverage [--format <table\|navigator>] [--json]`                | Print the control mapping against MITRE ATLAS and OWASP ASI, built from the attack corpus's own scenario tags; `--format=navigator` emits an ATT&CK Navigator layer                                                                                             |
| `stroq harden [plan\|apply\|undo\|status] [--json]`                    | Strengthen Claude Code's or Cursor's own protection of credential files, and undo it exactly. `plan` (default) writes nothing; `apply` and `undo` ask, or need `--yes` off a terminal. A filter in the agent, not a guarantee                                   |

`stroq prove --agent codex` uses the existing ChatGPT login and `gpt-5.6-luna` (measured
with Codex CLI 0.162.1 on Windows; other platforms and versions are refused). It runs the fixed probes without Codex's sandbox and
bypasses hook trust for this invocation, with identical permissions in the control.
Existing user hooks or local managed hook sources cause a refusal before inference.
This includes `stroq init --agent codex --user`, which writes `~/.codex/hooks.json`.
Back up and temporarily move that file aside yourself for the check, then restore it;
Stroq never disables it automatically. Refused isolation/login preflights report zero
requests. A ledger slot reserved before a refused preflight stays reserved conservatively.
The hook under test is Stroq's line started through a private wrapper that supplies the
temporary policy/audit home. Codex keeps its authentication home. The driver cannot
detect a plan's pay-as-you-go credits; reported billing and cwd come from login preflight,
forced configuration and spawn options rather than independent host stream fields.
The driver starts a native executable directly; for npm Windows installations, set
`STROQ_CODEX_BIN` to the absolute path of the package's native `codex.exe`. The executable
is resolved once and reused for version, login and inference. See the
[recorded fixtures and limitations](https://github.com/AGGIB/Stroq/blob/main/packages/cli/test/fixtures/hosts/codex/README.md).

`stroq exposure` reads files only. `--probe` is the one flag that starts a process: it launches each configured stdio MCP server, asks once for `tools/list`, scans the tool descriptions and shuts the server down — no tool is ever called. Without it, tool-description poisoning is not covered by the run, and the report says so. `--share` prints a redacted summary built from a whitelist, locally; nothing is transmitted.

The corpus `stroq bench` measures against ships with this repository, not with the npm package; on an installed CLI, point it at your own documentation with `stroq bench --corpus <dir>` — the published number in [`docs/BENCH.md`](https://github.com/AGGIB/Stroq/blob/main/docs/BENCH.md) is exactly that command run against the vendored corpus.

## Learn more

- Full documentation, architecture, and the demo: [github.com/AGGIB/Stroq](https://github.com/AGGIB/Stroq/blob/main/docs/GUIDE.md)
- Report a security issue or a bypass: [SECURITY.md](https://github.com/AGGIB/Stroq/blob/main/SECURITY.md)

License: Apache-2.0.
