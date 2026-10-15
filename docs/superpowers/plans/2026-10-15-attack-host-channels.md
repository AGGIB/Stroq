# Attack Host Channels and Visibility Plan

## Objective
Implement host channel visibility mapping and `--host` flag for `stroq attack` (Issue #231).
Provide machine-readable table `packages/cli/src/hosts/channels.ts`, report unsupported attack steps when evaluating against a specific host, generate `docs/HOSTS.md` checked in CI, and ensure full synchronization between the codebase and documentation.

---

## 5-Commit Execution Rhythm

### Commit 1: `docs(plans): add host channel visibility and attack --host implementation plan`
- Create `docs/superpowers/plans/2026-10-15-attack-host-channels.md` detailing architecture, channel definitions, host capabilities, CLI behavior, reporting, and acceptance tests.

### Commit 2: `feat(hosts): define host channel visibility table and AGENTS.md cross-validation`
- Create `packages/cli/src/hosts/channels.ts`:
  - Enumerate 8 hosts: `claude-code`, `cursor`, `codex`, `copilot`, `openclaw`, `windsurf`, `antigravity`, `mcp`.
  - Enumerate 6 channels: `shell command`, `file write`, `file read`, `MCP call`, `tool result`, `web fetch`.
  - Define `HostChannelRecord` with `status: 'seen' | 'not seen' | 'partial' | 'unknown'` and `evidence: string`.
  - Provide `channelForStep(event)` and `isStepSupportedOnHost(host, event)`.
- Update `docs/AGENTS.md` with an explicit summary table mapping all 8 hosts to ensure bidirectional validation.

### Commit 3: `feat(attack): add --host flag with unsupported step accounting and exit behavior`
- Update `packages/cli/src/help.ts` to add `--host <id>` under `attack`.
- Update `packages/cli/src/commands/attack.ts` to parse `--host`.
- Update `packages/cli/src/attack/run.ts`:
  - Add optional `host?: string` parameter to `runAttack`.
  - When `host` is given, classify each scenario step's channel.
  - If a step is unsupported (`not seen` on the specified host), record it as unsupported.
  - When any step in a scenario is unsupported, treat it as not passed and set `report.ok = false`.
  - Add additive fields to `AttackReport` (`host?: string`, `unsupportedSteps?: number`, `unsupportedScenarios?: number`).
- Update `packages/cli/src/attack/report.ts`:
  - Format unsupported steps in human-readable output without altering default numbers (36, 17, 19, 0) when `--host` is omitted.

### Commit 4: `docs(hosts): generate docs/HOSTS.md and document --host in GUIDE and README`
- Implement generation of `docs/HOSTS.md` derived from `packages/cli/src/hosts/channels.ts`.
- Wire `docs/HOSTS.md` into `scripts/generate-reports.ts` for both `pnpm generate:reports` and `pnpm check:reports`.
- Update `docs/GUIDE.md` and `packages/cli/README.md` command tables and prose to document `--host <id>`.
- Verify `pnpm check:reports` and `node node_modules/vitest/vitest.mjs run packages/cli/test/docs-tables.test.ts`.

### Commit 5: `test(hosts): verify host channels, docs table synchronization, and attack --host isolation`
- Create `packages/cli/test/hosts/channels.test.ts` testing:
  - Bidirectional check: every host in table has a row in `docs/AGENTS.md` and vice versa.
  - Evidence constraint: every cell has a non-empty evidence string citing `AGENTS.md` or a fixture.
  - Step classification: all 36 attack scenarios map correctly to the 6 channels.
- Create `packages/cli/test/commands/attack-host.test.ts` testing:
  - Default `stroq attack` produces identical baseline numbers: 36 scenarios, 17 blocked, 19 asked, 0 passed.
  - `stroq attack --host claude-code` succeeds with exit 0 and 0 unsupported steps.
  - `stroq attack --host codex` / `cursor` / `mcp` identifies unsupported steps and exits 1.
  - Invalid `--host unknown` exits 1 with a descriptive error.
  - JSON output maintains backward compatibility with additive fields.
- Verify full typecheck and prettier across the workspace.
