<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
  <img src="docs/assets/logo.svg" alt="Stroq" width="340">
</picture>

### Local action firewall for AI coding agents

Scans what the agent reads. Taints the session. Blocks the dangerous follow-up — before anything leaves your machine.

[![CI](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml/badge.svg)](https://github.com/AGGIB/Stroq/actions/workflows/ci.yml)
[![stroq attack: 12/12 stopped](https://img.shields.io/badge/stroq%20attack-12%2F12%20stopped-1f9d55)](#replay-twelve-real-incidents)
[![npm version](https://img.shields.io/npm/v/%40stroq%2Fcli?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/@stroq/cli)
[![npm downloads](https://img.shields.io/npm/d18m/%40stroq%2Fcli?label=downloads&color=0b7285)](https://www.npmjs.com/package/@stroq/cli)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)

```bash
npx @stroq/cli init
```

Supported today: **Claude Code**, **Cursor** (native hooks) · On the roadmap: Codex, Copilot, OpenClaw

**Website:** [stroq.vercel.app](https://stroq.vercel.app)

</div>

---

## Why

Coding agents read untrusted content constantly — web pages, file contents, MCP tool results, the output of commands they just ran themselves. When that content hides instructions, an agent that dutifully follows what it reads can turn them into real actions: outbound network requests, secret reads, external git pushes, arbitrary shell execution.

Stroq sits on the agent's own tool-call hooks and enforces a deterministic, local policy on those actions. No cloud round trip, no proxy, and no relying on the model to notice the injection itself.

## See it block an attack

<img src="docs/assets/demo.gif" alt="Stroq in Claude Code: a poisoned README taints the session, curl | sh is denied, an npx copied from an MCP result is asked about with its provenance, a curl carrying a .env value is denied by deny-secret-egress, and stroq attack reports 8 blocked, 4 asked, 0 passed through" width="800">

1. Claude Code reads a dependency's `README.md` that hides an instruction to run `curl | sh` and a base64-encoded command to exfiltrate `~/.ssh/id_rsa`.
2. Stroq's `PostToolUse` scan matches 13 rules across two rule sets, marks the session `suspect`, and hands the agent an inline warning to treat the file as untrusted.
3. When the next command tries to run that `curl | sh`, the tainted `PreToolUse` policy denies it outright (`deny-encoded-exec`) — before any request leaves the machine.
4. An MCP result suggests `npx @sentry-tooling/report-fix --apply`; no rule flags it, but when the agent runs exactly that command Stroq asks and names the MCP result it came from (`ask-origin-untrusted`).
5. A `curl` whose body carries the value of `DEMO_API_KEY` from the project's `.env` is denied (`deny-secret-egress`); the reason names the variable and the file, the audit line shows `[REDACTED:DEMO_API_KEY]`.
6. `stroq attack` replays twelve recorded incidents against the same policy: 8 blocked, 4 asked, 0 passed through.

Provenance goes one step further. Run the demo and watch event 4: an MCP result that no rule flags (its auto-generated "suggested fix" tells the agent to run `npx @sentry-tooling/report-fix --apply`) still leaves a trace, so when the agent's next command is exactly that `npx`, Stroq asks — and says why: _"@sentry-tooling/report-fix" appeared in the output of mcp__sentry__get_issue … tool output is data, not instructions._ This is the shape of the June 2026 Sentry "agentjacking" attack, which reached an 85% success rate against Claude Code, Cursor and Codex ([Tenet Security](https://tenetsecurity.ai/blog/agentjacking-coding-agents-with-fake-sentry-errors/)).

Run it yourself: `pnpm install && pnpm build && ./examples/demo/run-demo.sh`.

### Replay twelve real incidents

`stroq attack` replays recorded hook events from twelve public incidents — Sentry agentjacking, s1ngularity, RoguePilot, Comment-and-Control, ToxicSkills, the `rm -rf ~` and `drizzle-kit push --force` horror stories and more — through the engine with _your_ policy (`~/.stroq/policy.yaml` when present, otherwise the default) in throwaway directories — sessions, audit log, secret index, credential files and environment are all fake, so beyond the policy nothing on your machine is read — and tells you which of them would get through:

```text
stroq attack: 12 recorded incidents against policy default
✔ 01-readme-pipe-to-shell          blocked  deny-encoded-exec                  Protestware for coding agents (jqwik): repo content addressed to the agent (2026-05)
✔ 02-sentry-agentjacking           asked    ask-origin-untrusted               Tenet Security: agentjacking coding agents with fake Sentry errors (2026-06)
✔ 03-token-in-mcp-comment          blocked  deny-secret-egress                 Comment-and-Control: prompt injection and credential theft through PR comments (2026-04)
✔ 04-s1ngularity-public-repo       blocked  deny-push-external-when-tainted    Wiz: s1ngularity — the Nx supply-chain attack that weaponised AI CLIs (2025-08)
✔ 05-roguepilot-schema-url         blocked  deny-secret-egress                 Orca Security: RoguePilot — token exfiltration through a GitHub Copilot $schema fetch (2026-03)
✔ 06-env-dump-exfil                blocked  deny-origin-suspect                claude-code #44868: a token leaked despite CLAUDE.md rules and a guard hook (2026-07)
✔ 07-settings-hook-removal         blocked  deny-self-tamper                   Check Point: RCE and token exfiltration through Claude Code project files (CVE-2025-59536) (2026-01)
✔ 08-rm-rf-home                    asked    ask-destructive                    Docker: coding agent horror stories — the rm -rf incident (2026-06)
✔ 09-drizzle-force-push            asked    ask-destructive                    claude-code #27063: drizzle-kit push --force wiped a production database (2026-04)
✔ 10-skill-base64-installer        blocked  deny-encoded-exec                  Snyk ToxicSkills: malicious agent skills on ClawHub (2026-02)
✔ 11-fetched-page-ssh-key-upload   blocked  deny-origin-suspect                Rehberger: breaking Claude Code auto mode with indirect prompt injection (2026-08)
✔ 12-parent-dir-wipe               asked    ask-destructive                    Cursor forum: agent wiped the whole drive (2026-08)
12 scenarios: 8 blocked, 4 asked, 0 passed through — every attack was stopped.
```

Every scenario cites the incident it models (`stroq attack --json` includes the links). The exit code is 1 when any scenario does not behave as expected, so a weakened `policy.yaml` fails your CI, and `--only 05` replays one scenario. The suite is the acceptance test for the default policy: CI runs it on every push to `main` and every pull request. Live mode (driving a real agent session) is not part of it.

## How it works

```mermaid
flowchart LR
    subgraph read [" PostToolUse · what the agent reads "]
        R[Read · WebFetch · Bash output · mcp__*] --> N[Normalize<br/>zero-width, homoglyphs, base64 / hex / url]
        N --> S[Scan<br/>599 rules]
    end
    S -- "score ≥ threshold" --> T[(Session taint<br/>suspect)]
    subgraph act [" PreToolUse · what the agent wants to do "]
        A[Bash · Write · Edit · WebFetch · mcp__*] --> C[Classify<br/>shell.network · fs.secrets · git.push_external · …]
        C --> P{Policy<br/>first match wins}
    end
    T -.-> P
    P -- deny --> D[Blocked]
    P -- ask --> K[You decide]
    P -- allow --> G[Runs]
    D & K & G --> L[(Hash-chained audit<br/>~/.stroq/audit.jsonl)]
```

1. **`PostToolUse` — scan and taint.** The output of `Read`, `WebFetch`, `WebSearch`, `Bash`, `Grep`, and every `mcp__*` tool is normalized (zero-width characters and tag/variation-selector code points stripped, homoglyphs folded, base64/hex/URL-encoded content decoded up to two levels) and matched against the rule set. If the highest-severity match scores at or above `threshold` (0.6 by default), the session is marked `suspect` and the agent gets an inline warning telling it to treat the content as untrusted data.
2. **`PreToolUse` — classify and decide.** `Bash`, `Write`/`Edit`/`MultiEdit`/`NotebookEdit`, `Read`, `WebFetch`, and `mcp__*` calls are classified into action classes (`shell.network`, `shell.destructive`, `shell.exec_encoded`, `fs.secrets`, `git.push_external`, `config.self`, `config.self_touch`, `mcp.side_effect`, and more) and evaluated against an ordered policy — first matching rule wins, otherwise the configured default (`allow`).
3. **Audit.** Every decision, on both hooks, is appended to a hash-chained JSONL log (`~/.stroq/audit.jsonl`), with sensitive values redacted before they're written. `stroq verify` checks that the chain hasn't been tampered with. A false positive can be cleared with `stroq untaint --session <id>` (the session id is shown in `stroq log`).

If Stroq itself crashes while handling a high-impact tool call, it fails **closed** — deny — rather than silently letting the action through.

## What you get

- **Provenance: Stroq knows where an instruction came from.** Every scanned tool output leaves a bounded, redacted trace of its _actionable atoms_ — URLs and hosts, `npx`/`pip install` package names, `curl … | sh` lines, base64 blobs. When a later command contains one of them, the decision carries the evidence (`stroq why` shows it, and so does the hook reason Claude Code displays): an unknown package or a pipe-to-shell copied from a file, a web page or an MCP result is asked about; copied from content Stroq had already flagged, it is denied. Packages the project already depends on are ignored for shell commands, so `npx tsc` from your own README stays silent.
- **Secret egress guard: Stroq knows where your secrets are going.** The values of secrets on this machine — the project's `.env*` files, `~/.aws/credentials`, `~/.npmrc`, `~/.netrc`, `~/.docker/config.json`, and credential-shaped environment variables — are indexed as salted hashes. An outbound action (network command, web fetch, MCP call, external push, encoded exec) whose arguments contain one of those values is denied and the reason names the secret and its file, never the value. `stroq canary` prints a decoy secret to plant; any outbound use of it is a certain positive that also taints the session.
- **Twelve incidents you can replay.** `stroq attack` runs recorded hook events from public incidents through your own policy and reports `blocked` / `asked` / `passed` per scenario, with the source of each. It is how we check that a change to the classifier or the default policy does not silently let an old attack back in.
- **Content scanning with real normalization.** Zero-width and tag characters stripped, homoglyphs folded, nested base64/hex/URL decoding — so `сurl` with a Cyrillic `с`, or a command hidden in base64, is matched like the plain text it decodes to.
- **599 gated rules.** 12 hand-written Stroq rules plus 596 vendored [Agent Threat Rules](https://github.com/Agent-Threat-Rule/agent-threat-rules), every one of them passed through a benign-corpus false-positive gate and a regex performance gate before it ships. Russian-language rule variants included.
- **Taint-aware policy.** The decision about an action knows whether the agent has read something suspicious in this session. Thirteen action classes, one ordered YAML policy, first match wins.
- **Self-protection.** An agent that has been tainted cannot edit Stroq's own policy, hooks, or `.claude/settings.json` (`config.self` → deny); touching them at all asks first.
- **Tamper-evident audit.** Hash-chained JSONL with structural redaction, `0600` permissions, and `stroq verify`.
- **Fail-closed.** Engine error on a high-impact `PreToolUse` call means deny, not allow.
- **Local and zero-config.** One command to install, nothing sent anywhere, a single YAML file if you want to change the defaults.

## How it's different

- **The agent's own permission prompts** ask about an action; they don't know that the agent just read a README telling it to run that action. Stroq carries that context (taint) into the decision and never relies on the model noticing the injection.
- **A regex in a hook script** sees the raw text. Stroq normalizes first (zero-width, homoglyphs, nested encodings), ships hundreds of gated rules instead of a handful, and records every decision in a log you can verify.
- **Cloud AI-security platforms** put a network round trip in the hot path. Agent hooks fail open on timeout, so a guard that is slow to answer silently stops guarding. Stroq is local, deterministic, and fails closed on high-impact actions.

## Install

```bash
npx @stroq/cli init                  # Claude Code: writes .claude/settings.json hooks
npx @stroq/cli init --agent cursor   # Cursor: writes .cursor/hooks.json
npx @stroq/cli doctor                # check the installation
```

`init` writes hooks into the project's `.claude/settings.json` by default; pass `--user` to install into `~/.claude/settings.json` instead, or `--dry-run` to preview the change without writing anything. Then open Claude Code in that project.

Prefer a persistent install? `npm install -g @stroq/cli` installs the `stroq` command globally — then run `stroq init` and `stroq doctor` directly.

### Cursor

```bash
npx @stroq/cli init --agent cursor   # in your project: writes .cursor/hooks.json
```

`--user` writes `~/.cursor/hooks.json` instead, `--dry-run` prints the merged file without writing it. Restart Cursor afterwards; `stroq doctor` then shows a `cursor hooks` line next to the Claude Code one. Re-running `init` is idempotent and replaces an older Stroq entry rather than stacking a second one; foreign hooks and foreign events in the file are left untouched.

Stroq installs on six of Cursor's hook events:

| Cursor event           | What Stroq does                                                                                                                                      | Can it stop the action?                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `beforeShellExecution` | Classifies the command, applies your policy                                                                                                          | Yes — `deny` / `ask`                                                                                |
| `beforeMCPExecution`   | Classifies the MCP call and its arguments, secret egress included                                                                                    | Yes — `deny` / `ask`                                                                                |
| `beforeReadFile`       | Scans the file body before the agent sees it; taints the session                                                                                     | Allow/deny only — a suspect file is allowed with a warning; a credential file under taint is denied |
| `afterShellExecution`  | Scans the terminal output, taints the session, records provenance                                                                                    | No                                                                                                  |
| `afterMCPExecution`    | Scans the MCP result, taints, records provenance                                                                                                     | No — but a suspect result adds `additional_context` for the agent (best-effort, see Limits)         |
| `afterFileEdit`        | Records the edit's classification (`config.self` for `.cursor/hooks.json`, `.claude/settings.json`, `~/.stroq/…`) as `allow(cursor-edit-unenforced)` | No — Stroq v1 installs on no Cursor event that could stop an edit; audit only                       |

`beforeShellExecution` and `beforeMCPExecution` are installed with `failClosed: true`, so a crashed or missing Stroq blocks those two events instead of silently allowing them. The other four are installed without `failClosed`, because a crash there cannot let a high-impact _action_ through: the blocking events still gate the shell command or MCP call that follows. The one deny outside those two — `beforeReadFile` refusing a credential path under taint — is therefore best-effort: an internal error on that event allows the read rather than stalling the agent.

**Limits.**

- **Edits through Cursor's editor are audited, not blocked.** Cursor has no `beforeFileEdit`. It does offer a generic `preToolUse` hook that can block writes and deletes, but Stroq v1 does not install on it — a deliberate scope cut, and the next Cursor step on the [roadmap](#roadmap). So a write to Stroq's own config made through Cursor's editor is recorded in `stroq log` as `allow(cursor-edit-unenforced) [config.self]`: the edit happened and is on the record, and the line never claims a block that did not occur (`stroq why` keeps explaining the last real denial). The equivalent shell command (`rm .cursor/hooks.json`, `sed -i … .claude/settings.json`) still goes through `beforeShellExecution` and is denied there.
- **The project follows the workspace root, not the agent's shell `cwd`.** Stroq resolves the project directory as `workspace_roots[0]`, falling back to Cursor's own `cwd` field only when the workspace root is absent, and to the process's `cwd()` as a last resort. A `cd /tmp` inside the agent's shell does not shed the project's `.env*` secret index — the workspace root, not the shell's current directory, decides which project's secrets and paths apply.
- **A multi-root workspace is indexed through its first root only.** `workspace_roots[0]` is the project for every event, so `.env*` files in the other roots are not in the secret index and their values are not recognised on the way out. Open the root whose secrets you care about first, or install Stroq per project.
- **Cursor's own web reads are not scanned.** Cursor has no hook for the content its agent fetches from the web, so a poisoned page reached that way is neither scanned nor taints the session — unlike Claude Code, where `WebFetch`/`WebSearch` go through `PostToolUse`. Content that arrives through a file read, a terminal command or an MCP call is covered as usual.
- **`sandbox` is ignored.** `beforeShellExecution` reports whether Cursor will run the command sandboxed; the policy applies either way, because a sandboxed `curl` still exfiltrates.
- **`additional_context` on `afterMCPExecution` is best-effort.** That field is documented by the community rather than on Cursor's official hooks page, so a client that ignores it simply gets no warning text — the taint it accompanies is set regardless and is enforced on the next action.
- **A poisoned terminal output taints silently.** `afterShellExecution` honours no output, so the agent is not told; the next network command, secret read or external push is denied all the same.
- **`beforeReadFile` cannot ask.** A file that scans as suspect is allowed with a `user_message` warning and taints the session; only a credential path (`fs.secrets`) under an already-tainted session is denied. An internal error on this event allows the read, so a taint can be missed — it is not a high-impact action.
- **Not used in v1:** Cursor's Tab hooks (`beforeTabFileRead`, `afterTabFileEdit`), the generic `preToolUse`/`postToolUse` events, `beforeSubmitPrompt`, `updated_input` rewriting and enterprise/team hook locations.
- **Untested:** the Cursor CLI (`cursor-agent`) and Windows. Both are expected to work wherever `.cursor/hooks.json` is honoured. There is no plugin install path — Cursor has no plugin system, so `stroq init --agent cursor` is the only one.

Run the Cursor demo yourself: `pnpm install && pnpm build && ./examples/demo/run-cursor-demo.sh`.

### As a Claude Code plugin

The repository is also a plugin marketplace. Inside Claude Code:

```text
/plugin marketplace add AGGIB/Stroq
/plugin install stroq@stroq
```

This registers the same `PreToolUse`/`PostToolUse` hooks as `stroq init` without touching your `.claude/settings.json`, so `stroq doctor` will report the settings-file hooks as missing — that is expected. The plugin's hook wrapper runs a globally installed `stroq` when there is one (fastest), and otherwise `npx -y @stroq/cli@<pinned version>` (the first run downloads the package). If neither can start, a `PreToolUse` event exits with code 2, which Claude Code treats as _block_: a missing runtime never silently disables the firewall. For the lowest per-call latency, `npm install -g @stroq/cli` alongside the plugin.

### From source

```bash
git clone https://github.com/AGGIB/Stroq.git
cd Stroq
pnpm install && pnpm build
node packages/cli/dist/index.js init
node packages/cli/dist/index.js doctor
```

## Commands

| Command                                                         | What it does                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `stroq init [--agent claude-code\|cursor] [--user] [--dry-run]` | Install hooks into `.claude/settings.json` or `.cursor/hooks.json` (`--user` for the home-directory copy) |
| `stroq hook claude-code` / `stroq hook cursor`                  | Hook entrypoint (reads the event on stdin)                                                                |
| `stroq doctor`                                                  | Check Node version, rules, hooks for both agents, self-test                                               |
| `stroq log [--count 20]`                                        | Show recent audit entries                                                                                 |
| `stroq verify`                                                  | Verify the audit hash chain                                                                               |
| `stroq untaint [--session <id>] [--all]`                        | Clear a false-positive session's taint and provenance, or every session's                                 |
| `stroq why [--seq <n>]`                                         | Explain the most recent denied/asked action: rule, provenance, taint                                      |
| `stroq canary [--name <NAME>]`                                  | Print a canary secret to plant; its outbound use is denied and taints the session                         |
| `stroq attack [--json] [--only <id>]`                           | Replay 12 recorded incidents against your policy; exit 1 if any gets through                              |

## Policy

Copy [`policies/default.yaml`](policies/default.yaml) to `~/.stroq/policy.yaml` and edit it — rules are evaluated in order, the first match wins, and anything unmatched falls through to `default`. A custom `~/.stroq/policy.yaml` replaces the default policy wholesale, so provenance is enforced only if it contains rules for `origin.suspect` and `origin.untrusted` — copy `deny-origin-suspect` and `ask-origin-untrusted` from [`policies/default.yaml`](policies/default.yaml), keeping them ahead of the `ask-*` rules; the secret egress guard needs the same treatment — copy `deny-secret-egress` too, keeping it first. `threshold` (0–1) is the minimum scan score before a `PostToolUse` result taints a session as `suspect`. Set `STROQ_HOME` to relocate all state (policy override, sessions, the secret index, and the audit log) to a different directory.

### Default policy

Generated from [`policies/default.yaml`](policies/default.yaml); rules are evaluated top to bottom and the first match wins.

| Rule id                            | Effect    | When                                 |
| ---------------------------------- | --------- | ------------------------------------ |
| `deny-secret-egress`               | deny      | `secret.egress`, any taint           |
| `deny-self-tamper`                 | deny      | `config.self`, any taint             |
| `deny-encoded-exec`                | deny      | `shell.exec_encoded`, any taint      |
| `deny-origin-suspect`              | deny      | `origin.suspect`, any taint          |
| `deny-network-when-tainted`        | deny      | `shell.network`, taint = suspect     |
| `deny-fetch-when-tainted`          | deny      | `network.fetch`, taint = suspect     |
| `deny-secrets-when-tainted`        | deny      | `fs.secrets`, taint = suspect        |
| `deny-push-external-when-tainted`  | deny      | `git.push_external`, taint = suspect |
| `ask-origin-untrusted`             | ask       | `origin.untrusted`, any taint        |
| `ask-mcp-side-effect-when-tainted` | ask       | `mcp.side_effect`, taint = suspect   |
| `ask-self-touch`                   | ask       | `config.self_touch`, any taint       |
| `ask-destructive`                  | ask       | `shell.destructive`, any taint       |
| `ask-push-external`                | ask       | `git.push_external`, any taint       |
| _(no rule matched)_                | **allow** | default                              |

Commands that only read the security config — `cat`, `grep`, `git status`/`diff`/`add`, and the like — are classified as ordinary reads, not `config.self`, so they stay allowed; opening it in an editor or otherwise writing to it is what triggers `config.self` (deny) or `config.self_touch` (ask).

### Provenance

`origin.untrusted` fires when a proposed action contains an atom that appeared in an earlier tool output of the same session; `origin.suspect` additionally requires that output to have scanned as `suspect`. Only some atoms count: package specs (`npx`, `pnpm dlx`, `uvx`, `npm install`, `pip install`, `cargo install`, …), `curl`/`wget` piped into a shell, and base64 blobs always do; URLs and hosts count only when the action is already network-shaped (`shell.network`, `git.push_external`, `shell.exec_encoded`), so following a documentation link with `WebFetch` never asks. Package atoms found in `package.json` dependencies, `node_modules/.bin`, `requirements.txt`, `requirements-dev.txt` or `pyproject.toml` of the working directory are not counted for shell commands. Traces live in `~/.stroq/sessions/<hash>.prov.json` (named by a hash of the session id; hash, redacted excerpt ≤ 120 chars, source, timestamp; at most 2,000 per session; mode `0600`). Once an output is flagged suspect, every atom it contains is treated as dictated by it — including a project's own legitimate setup commands if they appeared in the same file — so the recovery for a false positive is `stroq untaint --session <id>` (the session id is shown in `stroq log`), which clears both the taint and the provenance trace. Per-source trust is planned. Provenance is text-level: an agent that reads a poisoned page and then writes its _own_ command is not attributed this way — that is what taint and the policy rules above are for — and a package the agent has itself added to `package.json` becomes "known", since provenance does not attribute `Write`/`Edit` calls.

### Secret egress guard

`secret.egress` fires when an egress-shaped action (`shell.network`, `network.fetch`, `mcp.call`, `mcp.side_effect`, `git.push_external`, `shell.exec_encoded`) carries the exact value of a known secret. Known secrets are the credential-named or vendor-shaped values (12+ characters, no whitespace, no placeholders, no paths, and no plain URLs or hostnames) found in the working directory's `.env*` files (except `.env.example`-style files, and at most 32 of them), `~/.aws/credentials`, `~/.npmrc`, `~/.netrc`, `~/.docker/config.json`, and in environment variables with credential-like names. The index at `~/.stroq/secrets.json` (mode `0600`) holds only `sha256(salt + value)`, the key name and the file path; it is rebuilt when a source changes, and environment variables are hashed live and never stored. The index is fully derivable from its sources, so a damaged file is rebuilt rather than blocking actions. `stroq doctor` shows a `secrets` line (`<n> values from <m> sources, <k> canaries`, or `index not built yet (built on the first outbound action)`) and fails that check — rather than reporting a comfortable zero — when a source exists but could not be read, when files were dropped, or when the index file was corrupt and will be rebuilt. The matched value is redacted from the audit summary as `[REDACTED:<name>]`.

**Limits.** The guard matches secret _values in the arguments_ of an outbound call. It does not know what a command will go on to read, so `curl -d @~/.aws/credentials …`, `cat ~/.aws/credentials | curl -d @- …` and `curl -d "$(cat .env)" …` are not `secret.egress` — they are covered by the `fs.secrets` class, which the default policy denies once the session is tainted (and, untainted, allows — the file path is recorded in the audit log, not blocked). Matching is exact (plus URL-decoded forms): a value concatenated with adjacent characters, split across two arguments, base64-encoded, or sent as a DNS label is not matched, and neither is a secret containing `/` that sits inside a URL path. `$VAR` expansion happens in the shell _after_ Stroq sees the command, so `curl -H "Authorization: Bearer $TOKEN"` is never flagged — which makes it the recommended way to pass a credential to a legitimate service. The guard is destination-unaware: a literal credential in the arguments is denied even when the destination is the credential's own service, so paste a token into a `curl` to its own API and you will be stopped. Only egress-shaped actions are checked (a secret in a purely local command is not egress); `Write` and `Edit` calls are not checked at all. Passwords inside connection URLs (`postgres://user:pw@host`) are not indexed, dotted or dot-prefixed values (`my.super.secret.pw1`, `.hidden-value-1`) are skipped as hostname-like, and neither `~/.ssh` private keys, `~/.kube/config` nor gcloud configs are indexed — reading those _files_ is still covered by `fs.secrets`. If a value is flagged that should not be, fix it at the source: rename the `.env` key so it is not credential-like (or drop the value) — a vendor-shaped value such as `ghp_…` is indexed whatever its key is called — or set the effect of `deny-secret-egress` to `ask` in your own `policy.yaml`.

## Rules

Stroq ships 12 hand-written rules in [`rules/stroq/`](rules/stroq/) (Apache-2.0) targeting instruction override, hidden directives to the agent, secret exfiltration, encoded execution, and related prompt-injection patterns — some with Russian-language rule alternatives and matching fixtures alongside the English ones. [`rules/atr/`](rules/atr/) vendors 596 more from [Agent Threat Rules](https://github.com/Agent-Threat-Rule/agent-threat-rules) (MIT).

Every rule is built through two gates, run locally by a maintainer (`pnpm build:rules`):

- **Benign-corpus gate:** any rule that fires on [`rules/fixtures/benign/`](rules/fixtures/benign/) is a false positive. A vendored ATR rule that fails this is disabled automatically ([`rules/atr-disabled.json`](rules/atr-disabled.json) currently lists 9); a Stroq-authored rule held to the same bar is never auto-disabled — a false positive fails the build instead, so the rule gets fixed.
- **Regex performance gate:** every rule is timed against adversarial blobs (repeated base64 alphabet, repeated characters, repeated URLs) at increasing sizes; anything over 25 ms is disabled before it ships, rather than shipping a rule that could stall a hook on real input.

That leaves 599 active rules at runtime out of 608 defined.

The performance gate's timings are machine-dependent, so CI never re-measures them: `pnpm build:rules --check` re-verifies rule compilation and the benign-corpus scan against the committed [`rules/atr-disabled.json`](rules/atr-disabled.json) and byte-compares the result against the committed bundle, deterministically and without timing anything. CI runs it with `--advisory-perf`, which additionally times every rule and prints a warning for anything over threshold that isn't already disabled, without failing the build — a rule that's consistently slow gets caught and disabled the next time a maintainer runs `pnpm build:rules` locally.

## Guarantees and limits

Stroq is young; here's what it actually gives you today, and where the edges are.

- **Fail-closed:** if Stroq errors out while handling a high-impact `PreToolUse` call, the action is denied, not silently allowed.
- **Cursor coverage is narrower than Claude Code's:** Stroq v1 installs on no Cursor event that can stop a file edit, so edits made through Cursor's editor are audited (`allow(cursor-edit-unenforced)`) rather than blocked; `afterShellExecution` cannot carry a warning back to the agent, and Cursor's own web reads have no hook at all — the taint, where there is one, is still enforced on the next action. The full table and limits are in [Cursor](#cursor).
- **Latency:** roughly 100–250 ms per hook invocation today (content-heavy `PostToolUse` scans sit at the high end), dominated by Node process startup rather than the scan itself — not "a few milliseconds," and not yet the local daemon described in the roadmap.
- **Regex denial-of-service is mitigated, not eliminated:** once a match starts, a single pathological regex cannot be interrupted mid-match — the scan's wall-clock budget is only checked _between_ rules and variants. The primary defense is the build-time performance gate described above, which keeps known-slow patterns out of the shipped rule set; if a scan still runs past its budget at runtime, the result fails closed (treated as `suspect`) instead of silently returning clean. True pre-emption via worker-thread isolation is on the [roadmap](#roadmap).
- **Audit log tail truncation is undetectable today:** the hash chain proves that no _existing_ entry was altered, but an attacker with local write access to `~/.stroq/audit.jsonl` who deletes the newest entries leaves no trace without an external anchor (signed checkpoints are future work).
- **Shell quote-splicing evasions are known:** certain shell-quoting tricks (for example `c"u"rl`, `$'curl'`) can split a command word in a way the classifier does not yet fully parse. A quote-aware lexer is on the roadmap; see [SECURITY.md](SECURITY.md) for the full, current out-of-scope list.

## Roadmap

- Local daemon with an ONNX-based classifier, replacing per-invocation Node startup and pure regex matching for the content scan.
- Adapters for Codex, Copilot, and OpenClaw.
- Cursor's generic `preToolUse` hook, so edits and deletes made through Cursor's editor can be blocked rather than only audited.
- A quote-aware shell lexer and worker-isolated scanning (see Guarantees and limits above).
- Team control plane: shared policy, fleet-wide audit visibility, and centralized false-positive triage across a team's agents.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting process, response targets, and current scope. This is a security tool, so a bypass of a documented protection is treated as a vulnerability, not a feature request.

We also deliberately never suggest installing Stroq via `curl | sh` — the entire point of this project is to stop that pattern, so use `npx`/`npm` or build from source instead.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, how to add a rule or a benign fixture, and the release process. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## License

Apache-2.0 — see [LICENSE](LICENSE). Vendored rules under [`rules/atr/`](rules/atr/) are MIT; see [`rules/atr/LICENSE`](rules/atr/LICENSE).
