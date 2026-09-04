# Stroq

**Local action firewall for AI coding agents.**

[![CI](https://github.com/AGGIB/stroq/actions/workflows/ci.yml/badge.svg)](https://github.com/AGGIB/stroq/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/stroq.svg)](https://www.npmjs.com/package/stroq)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-339933)](package.json)

## Why

Coding agents read untrusted content constantly — web pages, file contents, MCP tool results, the output of commands they just ran themselves. When that content hides instructions, an agent that dutifully follows what it reads can turn them into real actions: outbound network requests, secret reads, external git pushes, arbitrary shell execution. Stroq sits on the agent's own tool-call hooks and enforces a deterministic, local policy on those actions — no cloud round trip, no relying on the model to notice the injection itself.

## See it block an attack

<img src="docs/assets/demo.svg" alt="Terminal recording of Stroq scanning a poisoned README, tainting the session, and denying the resulting curl pipe sh command" width="920">

1. Claude Code reads a dependency's `README.md` that hides an instruction to run `curl | sh` and a base64-encoded command to exfiltrate `~/.ssh/id_rsa`.
2. Stroq's `PostToolUse` scan matches 13 rules across two rule sets, marks the session `suspect`, and hands the agent an inline warning to treat the file as untrusted.
3. When the next command tries to run that `curl | sh`, the tainted `PreToolUse` policy denies it outright (`deny-encoded-exec`) — before any request leaves the machine.

Run it yourself: `pnpm install && pnpm build && ./examples/demo/run-demo.sh`.

## Install

```bash
npx stroq init      # in your project: writes .claude/settings.json hooks
npx stroq doctor     # check the installation
```

`init` writes hooks into the project's `.claude/settings.json` by default; pass `--user` to install into `~/.claude/settings.json` instead, or `--dry-run` to preview the change without writing anything. Then open Claude Code in that project.

Supported today: **Claude Code** (via native hooks). Cursor, Codex, Copilot, and OpenClaw adapters are on the [roadmap](#roadmap).

### From source

```bash
git clone https://github.com/AGGIB/stroq.git
cd stroq
pnpm install && pnpm build
node packages/cli/dist/index.js init
node packages/cli/dist/index.js doctor
```

## What it does

1. **`PostToolUse` — scan and taint.** The output of `Read`, `WebFetch`, `WebSearch`, `Bash`, `Grep`, and every `mcp__*` tool is normalized (zero-width characters and tag/variation-selector code points stripped, homoglyphs folded, base64/hex/URL-encoded content decoded up to two levels) and matched against the rule set. If the highest-severity match scores at or above `threshold` (0.6 by default), the session is marked `suspect` and the agent gets an inline warning telling it to treat the content as untrusted data.
2. **`PreToolUse` — classify and decide.** `Bash`, `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, `Read`, `WebFetch`, and `mcp__*` calls are classified into action classes (`shell.network`, `shell.destructive`, `shell.exec_encoded`, `fs.secrets`, `git.push_external`, `config.self`, `config.self_touch`, `mcp.side_effect`, and more) and evaluated against an ordered policy — first matching rule wins, otherwise the configured default (`allow`).
3. **Audit.** Every decision, on both hooks, is appended to a hash-chained JSONL log (`~/.stroq/audit.jsonl`), with sensitive values redacted before they're written. `stroq verify` checks that the chain hasn't been tampered with. A false positive can be cleared with `stroq untaint --session <id>` (the session id is shown in `stroq log`).

If Stroq itself crashes while handling a high-impact tool call, it fails **closed** — deny — rather than silently letting the action through.

### Default policy

Generated from [`policies/default.yaml`](policies/default.yaml); rules are evaluated top to bottom and the first match wins.

| Rule id                            | Effect    | When                                 |
| ---------------------------------- | --------- | ------------------------------------ |
| `deny-self-tamper`                 | deny      | `config.self`, any taint             |
| `deny-encoded-exec`                | deny      | `shell.exec_encoded`, any taint      |
| `deny-network-when-tainted`        | deny      | `shell.network`, taint = suspect     |
| `deny-fetch-when-tainted`          | deny      | `network.fetch`, taint = suspect     |
| `deny-secrets-when-tainted`        | deny      | `fs.secrets`, taint = suspect        |
| `deny-push-external-when-tainted`  | deny      | `git.push_external`, taint = suspect |
| `ask-mcp-side-effect-when-tainted` | ask       | `mcp.side_effect`, taint = suspect   |
| `ask-self-touch`                   | ask       | `config.self_touch`, any taint       |
| `ask-destructive`                  | ask       | `shell.destructive`, any taint       |
| `ask-push-external`                | ask       | `git.push_external`, any taint       |
| _(no rule matched)_                | **allow** | default                              |

Commands that only read the security config — `cat`, `grep`, `git status`/`diff`/`add`, and the like — are classified as ordinary reads, not `config.self`, so they stay allowed; opening it in an editor or otherwise writing to it is what triggers `config.self` (deny) or `config.self_touch` (ask).

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

Copy [`policies/default.yaml`](policies/default.yaml) to `~/.stroq/policy.yaml` and edit it — rules are evaluated in order, the first match wins, and anything unmatched falls through to `default`. `threshold` (0–1) is the minimum scan score before a `PostToolUse` result taints a session as `suspect`. Set `STROQ_HOME` to relocate all state (policy override, sessions, and the audit log) to a different directory.

## Rules

Stroq ships 12 hand-written rules in [`rules/stroq/`](rules/stroq/) (Apache-2.0) targeting instruction override, hidden directives to the agent, secret exfiltration, encoded execution, and related prompt-injection patterns — some with Russian-language rule alternatives and matching fixtures alongside the English ones. [`rules/atr/`](rules/atr/) vendors 596 more from [Agent Threat Rules](https://github.com/Agent-Threat-Rule/agent-threat-rules) (MIT).

Every rule is built through two gates (`pnpm build:rules`):

- **Benign-corpus gate:** any rule that fires on [`rules/fixtures/benign/`](rules/fixtures/benign/) is a false positive. A vendored ATR rule that fails this is disabled automatically ([`rules/atr-disabled.json`](rules/atr-disabled.json) currently lists 7); a Stroq-authored rule held to the same bar is never auto-disabled — a false positive fails the build instead, so the rule gets fixed.
- **Regex performance gate:** every rule is timed against adversarial blobs (repeated base64 alphabet, repeated characters, repeated URLs) at increasing sizes; anything over 50 ms is disabled before it ships, rather than shipping a rule that could stall a hook on real input.

That leaves 601 active rules at runtime out of 608 defined.

## Guarantees and limits

Stroq is young; here's what it actually gives you today, and where the edges are.

- **Fail-closed:** if Stroq errors out while handling a high-impact `PreToolUse` call, the action is denied, not silently allowed.
- **Latency:** roughly 100–200 ms per hook invocation today, dominated by Node process startup rather than the scan itself — not "a few milliseconds," and not yet the local daemon described in the roadmap.
- **Regex denial-of-service is mitigated, not eliminated:** once a match starts, a single pathological regex cannot be interrupted mid-match — the scan's wall-clock budget is only checked _between_ rules and variants. The primary defense is the build-time performance gate described above, which keeps known-slow patterns out of the shipped rule set; if a scan still runs past its budget at runtime, the result fails closed (treated as `suspect`) instead of silently returning clean. True pre-emption via worker-thread isolation is on the [roadmap](#roadmap).
- **Audit log tail truncation is undetectable today:** the hash chain proves that no _existing_ entry was altered, but an attacker with local write access to `~/.stroq/audit.jsonl` who deletes the newest entries leaves no trace without an external anchor (signed checkpoints are future work).
- **Shell quote-splicing evasions are known:** certain shell-quoting tricks (for example `c"u"rl`, `$'curl'`) can split a command word in a way the classifier does not yet fully parse. A quote-aware lexer is on the roadmap; see [SECURITY.md](SECURITY.md) for the full, current out-of-scope list.

## Roadmap

- Local daemon with an ONNX-based classifier, replacing per-invocation Node startup and pure regex matching for the content scan.
- Adapters for Cursor, Codex, Copilot, and OpenClaw.
- A quote-aware shell lexer and worker-isolated scanning (see Guarantees and limits above).
- Team control plane: shared policy, fleet-wide audit visibility, and centralized false-positive triage across a team's agents.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting process, response targets, and current scope. This is a security tool, so a bypass of a documented protection is treated as a vulnerability, not a feature request.

We also deliberately never suggest installing Stroq via `curl | sh` — the entire point of this project is to stop that pattern, so use `npx`/`npm` or build from source instead.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, how to add a rule or a benign fixture, and the release process. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

```bash
pnpm test:coverage   # vitest, 80% threshold
pnpm typecheck
pnpm build
```

## License

Apache-2.0 — see [LICENSE](LICENSE). Vendored rules under [`rules/atr/`](rules/atr/) are MIT; see [`rules/atr/LICENSE`](rules/atr/LICENSE).
