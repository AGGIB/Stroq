# Bare Directory Tamper Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Reconcile obsolete documentation debt in `docs/AGENTS.md` and add exhaustive test coverage across Bash, PowerShell, and core self-config test suites for bare directory self-tamper detection (`PROTECTED_DIR_BARE`).

## Background & Architecture

Core commit `fde0087` introduced `PROTECTED_DIR_BARE` in `packages/core/src/actions/self-config.ts` to close a critical classification gap where destroying an agent's directory as a whole (e.g. `rm -rf .claude`, `rm -rf .windsurf`, `mv .cursor /tmp`, `rm -rf .windsurf/*`) destroyed the hook entries without matching `SELF_CONFIG_FILE`.

While `CHANGELOG.md:583` and `packages/core/test/actions/classification-gaps.test.ts` documented and tested this feature, `docs/AGENTS.md:223` retained an obsolete claim under Windsurf limits stating that bare directory operations were not caught. Furthermore, the primary command classifiers in `packages/core/test/actions/classify-bash.test.ts` and `classify-powershell.test.ts` lack systematic coverage for bare directory deletions and renames across all supported agent frameworks (`.windsurf`, `.codeium`, `.cursor`, `.codex`, `.openclaw`, `.agents`, `~/.gemini`, `.claude`, `.copilot`, `.devin`).

## Proposed Changes

### 1. `docs/superpowers/plans/2026-10-15-bare-directory-tamper-coverage.md`
- Implementation plan document tracking all tasks.

### 2. `packages/core/test/actions/classify-bash.test.ts`
- Add test coverage for bare directory deletion and renaming across all supported agent frameworks.
- Verify subpaths (`.windsurf/rules/`, `.agents/workflows/`, etc.) remain editable as ordinary work.

### 3. `packages/core/test/actions/classify-powershell.test.ts`
- Add test coverage for PowerShell cmdlets (`Remove-Item`, `Move-Item`, `rd /s /q`, `rmdir /s /q`, `del`) targeting bare agent directories.
- Verify ordinary PowerShell edits to non-hook files within those directories do not trip `config.self`.

### 4. `packages/core/test/actions/self-config.test.ts`
- Add tests for `classifySelfConfigSegment` covering all agent bare directories and verifying intermediate path limits (`~/.codeium/windsurf`, `~/.gemini/antigravity-cli`).

### 5. `docs/AGENTS.md`
- Reconcile line 223 in the Windsurf section to accurately describe `PROTECTED_DIR_BARE` protection and document intermediate directory behavior aligned with line 274.

## Verification Plan

### Automated Tests
- `pnpm vitest run packages/core/test/actions/classify-bash.test.ts`
- `pnpm vitest run packages/core/test/actions/classify-powershell.test.ts`
- `pnpm vitest run packages/core/test/actions/self-config.test.ts`
- `pnpm vitest run packages/core/test/actions/classification-gaps.test.ts`
- `pnpm typecheck`
- `pnpm format:check`
