# Security Policy

Stroq is a security product: its job is to block specific dangerous actions once specific untrusted content has been seen. If you can make a documented protection fail — a command the README says is denied that gets through, or poisoned content a rule should flag that the scanner misses — **that is a vulnerability in this project**, not a feature request, even if the underlying cause looks like "just a regex gap."

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.3.x   | Yes       |
| < 0.3   | No        |

Stroq is pre-1.0. Only the latest published `0.3.x` release is supported; please reproduce against the latest version before reporting.

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

**In scope:** any way to defeat a protection this project documents as working today for the Claude Code or Cursor adapter. For example: a `shell.network`, `shell.exec_encoded`, `git.push_external`, `fs.secrets`, or `config.self` action that the README or `policies/default.yaml` says should be denied or asked, but is instead silently allowed; or content that should trip a rule in `rules/stroq/` (or a non-disabled rule in `rules/atr/`) but is normalized and scanned as clean.

**Out of scope (known gaps, already on the roadmap — please still report if unsure, but expect these to be closed as duplicates of tracked work rather than triaged as new):**

- Evasions of the shell classifier that rely on shell quote-splicing or quoting the classifier does not fully parse yet (for example `c"u"rl`, `$'curl'`, heredoc/`<<<` and pipe-to-shell forms) — a quote-aware lexer for the Bash classifier is on the roadmap.
- Denial of a single scan via a pathological regex running past the build-time performance gate: worker-isolated scanning (so one slow match cannot stall the hook process) has not shipped yet; today the gate only rejects rules that are already slow against the fixed benchmark blobs.
- Adapters for any agent other than Claude Code and Cursor (Codex, Copilot, OpenClaw) — these do not exist yet, so there is nothing to bypass.
- The Cursor events Stroq deliberately does not install on in v1 (Tab hooks `beforeTabFileRead`/`afterTabFileEdit`, the generic `preToolUse`/`postToolUse` events, `beforeSubmitPrompt`), and the two Cursor limits the README documents: a file edit made through Cursor's editor is audited rather than blocked (Cursor has no `beforeFileEdit`), and `beforeReadFile` allows a suspect file with a warning instead of blocking it. An action that gets through a Cursor event Stroq _does_ install on is in scope.
- Tail truncation of the audit log (an attacker with local write access deletes the newest entries): documented as undetectable without an external anchor until signed checkpoints ship.
- Resource exhaustion against the hook process itself (for example, extremely large tool output) that does not cause an incorrect allow — track as a performance issue rather than a bypass, unless it causes Stroq to fail open instead of closed.

If you are not sure whether something is in scope, report it privately anyway.
