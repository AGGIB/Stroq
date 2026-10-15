# Command Table Flag Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Reconcile command table flag gaps in `docs/GUIDE.md` and `packages/cli/README.md` (`doctor --all`, `trust --json`, `prove [--json] [--max-requests]`), and expand `ROWS_NAME_EVERY_FLAG` in `packages/cli/test/docs-tables.test.ts` to strictly prevent documentation drift across core CLI commands.

## Background & Architecture

`packages/cli/test/docs-tables.test.ts` was introduced to enforce synchronization between CLI help definitions (`packages/cli/src/help.ts`) and Markdown command tables in `docs/GUIDE.md` and `packages/cli/README.md`. As noted in lines 53-57 of `docs-tables.test.ts`:
```ts
/**
 * Commands whose rows must name every flag `--help` lists for them: the three whose rows had
 * fallen behind their own help (`attack --fuzz`, `bench --actions`, `coverage` itself). Other
 * rows have older gaps (`init --yes`, `doctor --all`, ...) that are a separate piece of work,
 * so this is a list to grow, not a rule for every row yet.
 */
const ROWS_NAME_EVERY_FLAG = ['attack', 'bench', 'coverage'] as const;
```

Several core CLI command rows in the reference tables are missing documented flags:
- `stroq doctor`: missing `[--all]` in both `docs/GUIDE.md` and `packages/cli/README.md`.
- `stroq trust`: missing `[--json]` in `packages/cli/README.md`.
- `stroq prove`: missing `[--json]` and `[--max-requests <n>]` in `packages/cli/README.md`.
- Furthermore, `untaint`, `canary`, `log`, `why`, and `inspect` already document all flags in both tables, but are not yet locked in `ROWS_NAME_EVERY_FLAG`.

## Proposed Changes

### 1. `docs/superpowers/plans/2026-10-15-command-table-flag-completeness.md`
- Implementation plan document.

### 2. `docs/GUIDE.md`
- Update line 745 (`stroq doctor`) to include `[--all]` and describe its purpose (`--all lists every agent and scope, installed or not`).

### 3. `packages/cli/README.md`
- Update line 93 (`stroq doctor`) to include `[--all]` and mention `--all`.
- Update line 94 (`stroq prove`) to include `[--json]` and `[--max-requests <n>]`.
- Update line 98 (`stroq trust`) to include `[--json]`.

### 4. `site/docs/index.html`
- Reconcile `stroq doctor` synopsis / description in web docs table to include `--all`.

### 5. `packages/cli/test/docs-tables.test.ts`
- Expand `ROWS_NAME_EVERY_FLAG` to include `doctor`, `untaint`, `trust`, `canary`, `log`, `why`, `inspect`, and `prove`.
- Update the suite comment documenting that these commands are now enforced against flag drift.

## Verification Plan

### Automated Tests
- `pnpm vitest run packages/cli/test/docs-tables.test.ts`
- `pnpm typecheck`
- `pnpm format:check`
