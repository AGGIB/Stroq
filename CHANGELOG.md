# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-05

### Added

- **Secret egress guard.** Values of known secrets (project `.env*` files, `~/.aws/credentials`, `~/.npmrc`, `~/.netrc`, `~/.docker/config.json`) are indexed as salted hashes in `~/.stroq/secrets.json`; credential-shaped environment variables are hashed the same way but only live, at lookup time, and are never written to that file. An egress-shaped action whose arguments contain one of these values is denied by the new first default rule `deny-secret-egress` (new action class `secret.egress`), the reason names the secret and its source, and the value is redacted from the audit summary. Users with a custom `~/.stroq/policy.yaml` must add the rule to be protected.
- `stroq canary [--name <NAME>]`: prints a decoy secret to plant; its outbound use is a certain positive that also marks the session suspect. `stroq doctor` reports the index size and fails its `secrets` check when a source could not be read, project `.env*` files were dropped, or the index file was corrupt; `stroq why` explains secret-egress denials.
- Demo: event 6 exfiltrates a `.env` value with `curl` and is denied.
- `stroq attack [--json] [--only <id>]`: replays twelve recorded, incident-backed attack scenarios (a protestware README, Sentry agentjacking, Comment-and-Control, s1ngularity, RoguePilot's `$schema` token fetch, an `env | curl` exfiltration, a hooks-removal write, the `rm -rf ~` and `drizzle-kit push --force` incidents, a ToxicSkills base64 installer, a fetched page asking for `~/.ssh/id_rsa`, and a parent-directory wipe) through the engine with the active policy, in throwaway directories, and prints `blocked` / `asked` / `passed` per scenario with totals; exit code 1 when any scenario misbehaves. CI runs the suite on every push to `main` and every pull request.
- Classifier coverage for the incidents the suite replays: `rm -r` of any `~…` target is `shell.destructive`; `terraform destroy` / `apply -destroy`, `tofu destroy`, `pulumi destroy`, `drizzle-kit push --force`, `prisma migrate reset`, `prisma db push --force-reset` / `--accept-data-loss`, `supabase db reset --linked` / `--db-url` and `gh repo delete` are `shell.destructive`; `gh repo create … --push` is `git.push_external`.

## [0.2.0] - 2026-09-05

### Added

- **Provenance.** `PostToolUse` now records the actionable atoms of every scanned output (URLs/hosts, package specs, pipe-to-shell commands, base64 blobs) in a per-session, redacted, bounded trace; `PreToolUse` attributes proposed actions to those traces and adds two action classes, `origin.untrusted` and `origin.suspect`, evaluated by two new default rules (`ask-origin-untrusted`, `deny-origin-suspect`). Hook reasons and audit entries carry the evidence ("… appeared in the output of mcp__sentry__get_issue (…) 40 s ago"); clean outputs that contain atoms are annotated for Claude Code's auto-mode classifier via `classifierContext`. Packages the project already depends on are never counted for shell commands.
  - Upgrade note: a custom `~/.stroq/policy.yaml` replaces the default policy wholesale, so provenance is enforced only if it contains rules for `origin.suspect` and `origin.untrusted` — copy `deny-origin-suspect` and `ask-origin-untrusted` from `policies/default.yaml` (keeping them ahead of the `ask-*` rules).
- `stroq why [--seq <n>]`: explains the most recent denied or asked action — rule, provenance evidence, and session taint.
- `stroq untaint --session <id>` now also clears the session's provenance trace, so a false positive stops producing `origin.*` decisions.
- Demo: a Sentry-style poisoned MCP result (`examples/demo/events/4-post-mcp-sentry.json`) followed by the `npx` it suggests.

### Fixed

- **CI's rules-bundle check no longer depends on machine speed.** Previously, CI regenerated `packages/core/src/rules.bundle.json` and diffed it against the committed copy; a GitHub runner slower than the maintainer's machine could push a rule over the regex performance gate's threshold, disabling a rule the committed bundle didn't and failing CI with an unrelated-looking diff. `scripts/build-rules.ts --check` (wired into CI as `pnpm build:rules --check --advisory-perf`, and available locally as `pnpm check:rules`) now re-verifies rule compilation and the benign-corpus scan against the already-committed `rules/atr-disabled.json` and byte-compares an in-memory rebuild against the committed bundle, without measuring performance at all. `--advisory-perf` still times every rule and prints a `WARNING` for anything over threshold that isn't already disabled, but never fails the build.
- The local performance gate's threshold (`pnpm build:rules`, run by a maintainer to regenerate the bundle) dropped from 50 ms to 25 ms, leaving margin for machines slower than the one that produced the committed bundle.

### Changed

- `scripts/build-rules.ts` is now a thin CLI over `scripts/lib/rules-pipeline.ts`, a set of pure functions (load, compile, benign-corpus gate, timing gate, assemble, compare) covered directly by `packages/core/test/rules/rules-pipeline.test.ts`.
- npm package published as `@stroq/cli`; the unscoped name `stroq` is refused by the registry's similarity check. The CLI binary is unaffected — it's still invoked as `stroq` (`npm install -g @stroq/cli`, then `stroq init`; or `npx @stroq/cli init` for one-off use).

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
