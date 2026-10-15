# Sent --try Sample Session Implementation Plan

> **For agentic workers:** Implement task-by-task, verifying all tests after each step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `stroq sent --try` to allow users to evaluate `stroq sent` without needing an existing agent transcript or exposing local credential files.

**Architecture:**
- `packages/cli/src/commands/sent.ts`: Add `--try` flag to argument parsing. Implement `runSentTry(out: Output)` which allocates an ephemeral folder in `tmpdir()`, writes a synthetic `.env` with a made-up key and a sample Claude Code transcript, constructs an isolated `FileSecretIndex(secretsPath, fakeHome, {})`, scans the transcript, renders the synthetic report, and guarantees removal of the temporary directory via `finally`.
- `packages/cli/src/sent/report.ts`: Add `readonly synthetic?: boolean;` to `SentReport`.
- `packages/cli/src/sent/format.ts`: When `report.synthetic === true`, prefix the report with `SAMPLE SESSION (SYNTHETIC)` notices and provide tailored next steps (`stroq sent --last`, `stroq init`).
- `packages/cli/src/help.ts`: Add `[--try]` to `sent` synopsis and flags.
- `docs/GUIDE.md`, `packages/cli/README.md`, and `site/session-secret-scan/index.html`: Update documentation tables and simplify the manual setup recipe to recommend `npx @stroq/cli sent --try`.
- `packages/cli/test/commands/sent-try.test.ts`: Add isolation, cleanup, and rendering tests.

**Tech Stack:** TypeScript (ESM, Node >= 22), Vitest, Prettier.

---

### Task 1: Add Implementation Plan

- [x] Create `docs/superpowers/plans/2026-10-15-sent-try-sample-session.md`.

---

### Task 2: Implement `--try` in `packages/cli/src/commands/sent.ts` and `sent/format.ts`

**Files to modify:**
- `packages/cli/src/sent/report.ts`
- `packages/cli/src/sent/format.ts`
- `packages/cli/src/commands/sent.ts`

**Details:**
1. In `SentReport`, add `readonly synthetic?: boolean;`.
2. In `formatSent`:
   - Display synthetic notice banner when `report.synthetic === true`.
   - Update `nextLines` for synthetic reports to direct users to `sent --last` and `init`.
3. In `runSent`:
   - Parse `try: { type: 'boolean' }`.
   - When `values.try === true`, delegate to `runSentTry(out)`.
   - Ensure clean removal of temporary directory on success and error.

---

### Task 3: Expose `--try` in `help.ts` and Command Usage

**Files to modify:**
- `packages/cli/src/help.ts`
- `packages/cli/src/commands/sent.ts`

**Details:**
1. Update `USAGE` in `sent.ts` to include `stroq sent --try`.
2. Update `sent` entry in `help.ts`: synopsis `[--try]` and flag `['--try', 'scan a built-in sample session with a made-up key in a temporary folder']`.
3. Verify `help.test.ts`.

---

### Task 4: Reconcile Documentation and Website

**Files to modify:**
- `docs/GUIDE.md`
- `packages/cli/README.md`
- `site/session-secret-scan/index.html`

**Details:**
1. Update `sent` command table row in `GUIDE.md` and `packages/cli/README.md` with `[--try]`.
2. Update `site/session-secret-scan/index.html` `#try-it` section to point directly to `npx @stroq/cli sent --try`.
3. Run `docs-tables.test.ts`.

---

### Task 5: Add Comprehensive Tests for `--try`

**Files to create:**
- `packages/cli/test/commands/sent-try.test.ts`

**Details:**
1. Verify credential isolation: populate a fake `HOME` with real credentials and ensure none are read or indexed.
2. Verify cleanup: verify the temporary folder is deleted on success and on error.
3. Verify report shape and guidance: check synthetic banners and next actions.
4. Verify composition with `--json` and `--card`.
5. Verify non-interference with `sent --last` and `sent --transcript`.
