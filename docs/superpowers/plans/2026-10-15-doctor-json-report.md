# Doctor JSON Report Implementation Plan

> **For agentic workers:** Implement task-by-task, verifying all tests after each step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `stroq doctor --json` to emit a versioned, machine-readable JSON document (`version: 1`) of the diagnostic report already compiled by `doctorReport()`, keeping exit codes identical to the text version and composing with `--all`.

**Architecture:**
- `packages/cli/src/commands/doctor.ts`: Add `readonly version: 1; readonly ok: boolean;` to `DoctorReport`. Update `doctorReport()` to include `version: 1` and `ok`. In `runDoctor()`, parse `--json` and write indented JSON (`JSON.stringify(report, null, 2) + '\n'`) to `process.stdout`.
- `packages/cli/src/help.ts`: Add `[--json]` to `doctor` command synopsis and flag descriptions (`['--json', 'machine-readable output (version 1)']`).
- `docs/GUIDE.md` and `packages/cli/README.md`: Update `doctor` row to `stroq doctor [--all] [--json]` with description mentioning `; --json emits the report as JSON`.
- `packages/cli/test/docs-tables.test.ts`: Add `doctor` to `ROWS_NAME_EVERY_FLAG` to prevent future table flag drift.
- `packages/cli/test/commands/doctor.test.ts`: Add unit and integration tests with fake `HOME` / `STROQ_HOME`, verifying JSON schema, exit codes with and without installed hooks, and `--all` flag composition.

**Tech Stack:** TypeScript (ESM, Node >= 22), Vitest, Prettier.

---

### Task 1: Add Implementation Plan

- [x] Create `docs/superpowers/plans/2026-10-15-doctor-json-report.md`.

---

### Task 2: Implement `--json` Flag in `doctor.ts`

**Files to modify:**
- `packages/cli/src/commands/doctor.ts`

**Details:**
1. Update `DoctorReport` interface:
   ```typescript
   export interface DoctorReport {
     readonly version: 1;
     readonly ok: boolean;
     readonly checks: readonly DoctorCheck[];
   }
   ```
2. Update `doctorReport()` to populate `version: 1` and `ok: checks.every((c) => c.ok)`.
3. In `runDoctor(argv)`:
   - Check `const json = argv.includes('--json')`.
   - If `json`: write `JSON.stringify(report, null, 2) + '\n'` to `process.stdout`.
   - If not `json`: print text report as before.
   - Return `report.ok ? 0 : 1`.

---

### Task 3: Expose `--json` Flag in `help.ts`

**Files to modify:**
- `packages/cli/src/help.ts`

**Details:**
1. Update `doctor` command entry in `COMMANDS`:
   ```typescript
   {
     name: 'doctor',
     synopsis: 'doctor [--all] [--json]',
     about: [
       'check the installation: Node, rules, the hooks of every agent',
       'and when each was last called, a self-test',
     ],
     flags: [
       ['--all', 'list every agent and scope, installed or not'],
       ['--json', 'machine-readable output (version 1)'],
     ],
   }
   ```
2. Verify with `help.test.ts`.

---

### Task 4: Reconcile Documentation Tables and Guards

**Files to modify:**
- `docs/GUIDE.md`
- `packages/cli/README.md`
- `packages/cli/test/docs-tables.test.ts`

**Details:**
1. In `docs/GUIDE.md` Commands table:
   - Synopsis: `stroq doctor [--all] [--json]`
   - Add prose note describing `stroq doctor --json` format and output.
2. In `packages/cli/README.md` Commands table:
   - Synopsis: `stroq doctor [--all] [--json]`
3. In `packages/cli/test/docs-tables.test.ts`:
   - Add `'doctor'` to `ROWS_NAME_EVERY_FLAG` to enforce completeness in table tests.

---

### Task 5: Add Unit and Integration Tests

**Files to modify:**
- `packages/cli/test/commands/doctor.test.ts`

**Details:**
1. Verify `runDoctor(['--json'])` writes only valid JSON matching `{ version: 1, ok: boolean, checks: DoctorCheck[] }`.
2. Test fake `HOME` / `STROQ_HOME` with hook installed (exit 0, `ok: true`) and without hook installed (exit 1, `ok: false`).
3. Verify that `--all` composes with `--json` to output checks for every agent.
4. Verify CLI integration invocation via `spawnSync(CLI_ENTRY, ['doctor', '--json'])`.
