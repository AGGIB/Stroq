# Release Post-Publish Smoke-Test Implementation Plan

> **For agentic workers:** Implement task-by-task, verifying all tests after each step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-publish smoke-test matrix job to `.github/workflows/release.yml` that verifies the real published `@stroq/cli` package on npm across Linux, macOS, and Windows with empty homes and isolated environments.

**Architecture:**
- `.github/workflows/release.yml`:
  - Add `test_version` optional string input under `workflow_dispatch` to enable manual dry-run verification against an already published version without tagging.
  - Add `smoke-test` matrix job (`ubuntu-latest`, `macos-latest`, `windows-latest`) running after `github-release` (or immediately when `test_version` is provided).
  - Use `permissions: contents: read` and no secrets/tokens.
  - Set `timeout-minutes: 15`.
  - Install `@stroq/cli@<version>` into a temporary directory via `npm install --prefix` with retries.
  - Execute smoke checks under clean/empty `HOME`, `USERPROFILE`, and `STROQ_HOME`:
    1. `--version` matches the expected tag version.
    2. `attack` exits 0 with 36 scenarios and 0 passed through (reading count from output).
    3. `doctor` runs successfully.
    4. `hook claude-code` rejects a denied command with permissionDecision `deny`.
- `CONTRIBUTING.md`:
  - Update "Release Process" section to document the post-publish smoke test matrix and manual test invocation.
- `packages/cli/test/release/workflow.test.ts`:
  - Validate the `release.yml` workflow schema, job dependencies, permissions, matrix, and step actions.

**Tech Stack:** GitHub Actions, Node.js, Bash, Vitest, YAML parser.

---

### Task 1: Add Implementation Plan

- [x] Create `docs/superpowers/plans/2026-10-15-release-smoke-test.md`.

---

### Task 2: Implement Post-Publish Smoke-Test Matrix Job

**Files to modify:**
- `.github/workflows/release.yml`

**Details:**
1. Define the `smoke-test` job in `.github/workflows/release.yml`.
2. Configure matrix across `ubuntu-latest`, `macos-latest`, and `windows-latest` with `fail-fast: false`.
3. Pin action `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1` (v7.1.0) with Node 24.
4. Add retry loop for `npm install --prefix` to tolerate registry propagation delays.
5. Execute `--version`, `attack`, `doctor`, and `hook claude-code` with clean empty homes.

---

### Task 3: Support Manual `workflow_dispatch` Verification via `test_version`

**Files to modify:**
- `.github/workflows/release.yml`

**Details:**
1. Add `inputs.test_version` under `workflow_dispatch`.
2. Condition `publish` and `github-release` to skip when `test_version` is specified.
3. Configure `smoke-test` job condition to execute either when `github-release` succeeds or when `test_version` is passed.

---

### Task 4: Document Smoke Test in CONTRIBUTING.md

**Files to modify:**
- `CONTRIBUTING.md`

**Details:**
1. Update Step 7 and add Step 8 in "Release Process" in `CONTRIBUTING.md` explaining the automated cross-platform smoke-test and manual dry-run mode.

---

### Task 5: Add Workflow Verification Unit Tests

**Files to create:**
- `packages/cli/test/release/workflow.test.ts`

**Details:**
1. Parse `.github/workflows/release.yml` using `yaml`.
2. Assert job `smoke-test` exists with matrix `[ubuntu-latest, macos-latest, windows-latest]`.
3. Assert `permissions.contents === 'read'` and no tokens/secrets in environment.
4. Assert `timeout-minutes` is set and actions are pinned with commit SHAs.
5. Assert version and scenario checks do not use hard-coded version numbers.
