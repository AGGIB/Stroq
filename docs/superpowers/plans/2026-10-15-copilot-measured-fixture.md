# Copilot CLI Measured Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the real `preToolUse` and `postToolUse` hook contract for GitHub Copilot CLI 1.0.98 on macOS (`darwin-arm64`), produce sanitized versioned fixtures and an audit manifest, update adapter documentation, and add replay conformance tests.

**Architecture:**
- Capture scripts (`scripts/capture-copilot-fixture.ts`, `scripts/clean-copilot-fixture.ts`, `scripts/copilot-capture-recorder.ts`): prepare throwaway workspace with `.github/hooks/stroq.json` and isolated `COPILOT_HOME/hooks/stroq.json`, intercept live stdin and invoke built Stroq CLI (`stroq hook copilot <pre|post>`), log raw events with execution metadata, sanitize outputs (strip private machine paths, hashes, tokens), and emit `manifest.json`.
- Fixture store (`packages/cli/test/fixtures/hosts/copilot/1.0.98-darwin-arm64/`): sanitized JSON recordings of `preToolUse` and `postToolUse` for allowed shell command, denied self-tamper command, allowed file write, and scanned file read.
- Documentation (`packages/cli/test/fixtures/hosts/copilot/README.md`, `docs/AGENTS.md`, `docs/GUIDE.md`): details of measured version (1.0.98), OS (macOS darwin-arm64), measured tools, and limits.
- Conformance test (`packages/cli/test/adapters/copilot-measured-replay.test.ts`): replays every recorded hook input through `handleCopilotHook` and verifies decisions, reasons, and exit codes against the live recordings.

**Acceptance criteria:**
- [ ] Real hook invocations captured from Copilot CLI 1.0.98 on `darwin-arm64`.
- [ ] At least: allowed shell command, denied self-tamper command, file write, file read with post-tool scan.
- [ ] Sanitized fixtures with zero private credentials, tokens, or machine usernames.
- [ ] `packages/cli/test/fixtures/hosts/copilot/README.md` and documentation updates.
- [ ] Conformance replay test passing with 100% agreement.
- [ ] 5 atomic commits matching repository standards.

## Tasks

### Task 1: Scaffolding and Plan
- [ ] Write implementation plan document (`docs/superpowers/plans/2026-10-15-copilot-measured-fixture.md`).
- [ ] Commit 1: `docs(plans): add implementation plan for measured Copilot CLI fixture recording`.

### Task 2: Recorder and Capture Helper Scripts
- [ ] Create `scripts/copilot-capture-recorder.ts` emitting the standalone hook interceptor script.
- [ ] Create `scripts/capture-copilot-fixture.ts` and `scripts/clean-copilot-fixture.ts` supporting prepare, snapshot, control, and clean.
- [ ] Verify syntax and test helper invocation.
- [ ] Commit 2: `feat(scripts): add capture and clean helper scripts for Copilot CLI fixtures`.

### Task 3: Measured Host Capture Execution and Sanitization
- [ ] Run live capture with installed Copilot CLI 1.0.98 on `darwin-arm64` in throwaway project.
- [ ] Execute allow shell command, deny self-tamper command, file write, and file read.
- [ ] Clean and write sanitized fixtures and `manifest.json` under `packages/cli/test/fixtures/hosts/copilot/1.0.98-darwin-arm64/`.
- [ ] Commit 3: `test(copilot): record measured hook fixtures for Copilot CLI 1.0.98 on darwin-arm64`.

### Task 4: Documentation and Guide Updates
- [ ] Write `packages/cli/test/fixtures/hosts/copilot/README.md` describing measured release, OS, method, and limits.
- [ ] Update `docs/AGENTS.md` and `docs/GUIDE.md` confirming recorded wire contract for Copilot CLI 1.0.98.
- [ ] Run `pnpm format:check` and synchronize documentation tables if needed.
- [ ] Commit 4: `docs(copilot): document measured Copilot CLI 1.0.98 hook contract and fixtures`.

### Task 5: Replay Conformance Test
- [ ] Create `packages/cli/test/adapters/copilot-measured-replay.test.ts` replaying all measured hook calls.
- [ ] Verify 100% agreement between replay decision and recorded output.
- [ ] Run `pnpm test` and `pnpm format:check`.
- [ ] Commit 5: `test(copilot): add conformance replay test for recorded Copilot CLI fixtures`.
