# Security Policy

Stroq is a security product: its job is to block specific dangerous actions once specific untrusted content has been seen. If you can make a documented protection fail — a command the README says is denied that gets through, or poisoned content a rule should flag that the scanner misses — **that is a vulnerability in this project**, not a feature request, even if the underlying cause looks like "just a regex gap."

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.5.x   | Yes       |
| < 0.5   | No        |

Stroq is pre-1.0. Only the latest published `0.5.x` release is supported; please reproduce against the latest version before reporting.

## Reporting a Vulnerability

Report privately through GitHub Security Advisories, not a public issue:

**<https://github.com/AGGIB/stroq/security/advisories/new>**

Please include:

- The exact hook event JSON (or the command / content) that should have been blocked, asked, or flagged
- What Stroq actually did — the `stroq log` line, or the raw hook output
- What you expected, and which part of the README, `policies/default.yaml`, or a rule file documents that expectation
- Your Stroq version, Node version, and operating system

### Response Targets

- **Acknowledgement:** within 72 hours of submission.
- **Fix for a confirmed bypass:** within 14 days of confirmation.
- **Coordinated disclosure:** we will agree on a disclosure timeline with you, credit you in the release notes unless you ask to stay anonymous, and ask that details stay private until a fix or documented mitigation has shipped.

## Safe Harbor

Good-faith security research against Stroq — running the CLI against your own fixtures, or crafting inputs to a local instance you control, in order to find bypasses of its documented protections — is welcome and authorized. We will not pursue legal action for research that is conducted in good faith, reported responsibly through the process above, and that avoids privacy violations, data destruction, and disruption to systems or people other than your own test environment.

## Scope

**In scope:** any way to defeat a protection this project documents as working today for the Claude Code, Cursor, Codex or Copilot CLI adapter. For example: a `shell.network`, `shell.exec_encoded`, `git.push_external`, `fs.secrets`, or `config.self` action that the README or `policies/default.yaml` says should be denied or asked, but is instead silently allowed; or content that should trip a rule in `rules/stroq/` (or a non-disabled rule in `rules/atr/`) but is normalized and scanned as clean.

**Out of scope (known gaps, already on the roadmap — please still report if unsure, but expect these to be closed as duplicates of tracked work rather than triaged as new):**

- Evasions of the shell classifier that rely on shell quote-splicing or quoting the classifier does not fully parse yet (for example `c"u"rl`, `$'curl'`, heredoc/`<<<` and pipe-to-shell forms) — a quote-aware lexer for the Bash classifier is on the roadmap.
- Denial of a single scan via a pathological regex running past the build-time performance gate: worker-isolated scanning (so one slow match cannot stall the hook process) has not shipped yet; today the gate only rejects rules that are already slow against the fixed benchmark blobs.
- Adapters for any agent other than Claude Code, Cursor, Codex and Copilot CLI (OpenClaw) — these do not exist yet, so there is nothing to bypass.
- The Copilot limits the README documents: a hook slower than `timeoutSec` is treated as an allow by Copilot and its late deny is discarded, even on `preToolUse` (github/copilot-cli#2893), so a report that Stroq can be made to _time out_ is a performance issue unless it also shows Stroq answering incorrectly (the installed budget is Copilot's own `timeoutSec: 30`, not the 15 seconds the other three agents get, because a shorter one is less safe here); the cloud coding agent turns an `ask` into a deny; MCP server names are not visible to hooks, so every MCP call is classified as `mcp__copilot__<tool>` and no rule can be keyed on a Copilot MCP _server_; hooks defined by plugins do not fire (#2540) and may not fire in some subagent contexts (#2392); a call whose command, patch, path or URL Stroq cannot read at all is denied with `copilot-unreadable-input` rather than allowed, and a call naming more than 64 files or URLs with `copilot-too-many-targets`; `postToolUseFailure`, `permissionRequest`, `modifiedArgs`/`modifiedResult` and the session/compaction events are not installed on; and the `find` write-intent rule only recognises `.github/hooks` and `.github/copilot` as protected directories, so a `find .github -name 'stroq.json' -delete` that names no protected path in a single token is not caught (widening it to a bare `.github` would make deleting a CI workflow self-tampering, which is not a claim this project makes). An action that gets through `preToolUse` — including one hidden behind a forged `*** Add File:` line, a hostile or unprefixed MCP tool name, a `str_replace_editor` sub-command, or a `toolArgs` field spelling Stroq neither reads nor denies — is in scope. Stroq reads a shell command from `command`/`cmd`/`input`/`script`/`raw`, a file path from `path`/`file_path`/`raw` and a fetched URL from `url`/`uri`/`href`/`raw`, and treats `shell`, `sh`, `zsh`, `exec_command`, `local_shell` and `run_command` as shells alongside the documented `bash` and `powershell`; a spelling outside those lists that reaches the engine as an empty action is exactly the kind of report that is wanted. The Copilot wire format is inferred from GitHub's documentation rather than recorded from a real session, so a payload shape that reaches the engine as an empty action is exactly the kind of report that is wanted.
- The Codex limits the README documents: an `ask` is enforced as a deny because Codex's hook contract cannot prompt; Codex fails open when the hook command cannot start at all, and has no `failClosed` knob (Stroq answers its own errors with exit code 2 on `PreToolUse` for every tool in its matcher — `Bash`, `exec_command`, `shell`, `local_shell`, `apply_patch`, `ApplyPatch`, `mcp__*`); hosted tools such as `WebSearch` never reach hooks, so content Codex fetches from the web itself is not scanned; an `apply_patch` declaring more than 64 files is denied rather than classified; a call whose command or paths Stroq cannot read at all is denied with `codex-unreadable-input` rather than allowed; and the events v1 does not install on (`PermissionRequest`, `SessionStart`/`SessionEnd`/`Stop`/`Interrupt`, compaction). An action that gets through `PreToolUse` on any of those tools — including one hidden behind a forged `*** Add File:` line, a hostile MCP tool name, or a `tool_input` field spelling Stroq neither reads nor denies — is in scope. The Codex wire format is inferred from OpenAI's documentation and two third-party integrations rather than recorded from a real session, so a payload shape that reaches the engine as an empty action is exactly the kind of report that is wanted.
- The Cursor events Stroq deliberately does not install on in v1 (Tab hooks `beforeTabFileRead`/`afterTabFileEdit`, the generic `preToolUse`/`postToolUse` events, `beforeSubmitPrompt`), and the Cursor limits the README documents: a file edit made through Cursor's editor is audited as `allow(cursor-edit-unenforced)` rather than blocked, because v1 installs on neither `beforeFileEdit` (which Cursor does not have) nor the generic `preToolUse` (which it does, and which is on the roadmap); `beforeReadFile` allows a suspect file with a warning instead of blocking it; content Cursor itself fetches from the web is not scanned, because that has no hook; and a multi-root workspace is indexed through `workspace_roots[0]` only. An action that gets through a Cursor event Stroq _does_ install on is in scope.
- Tail truncation of the audit log (an attacker with local write access deletes the newest entries): documented as undetectable without an external anchor until signed checkpoints ship.
- Resource exhaustion against the hook process itself (for example, extremely large tool output) that does not cause an incorrect allow — track as a performance issue rather than a bypass, unless it causes Stroq to fail open instead of closed.

If you are not sure whether something is in scope, report it privately anyway.
