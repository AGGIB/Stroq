# Init, Uninstall, and Task Table Completeness Implementation Plan

## Context
Documentation tables in `docs/GUIDE.md` and `packages/cli/README.md` have historical flag omissions in `init` (`--yes`, `--no-input`), `uninstall` (`--client`, `--config`), and `task` (`--profile`, `--read`, `--write`, `--ttl`, `--hook-only`). Closing these gaps and expanding `ROWS_NAME_EVERY_FLAG` in `packages/cli/test/docs-tables.test.ts` enforces automated flag completeness across these management entrypoints. In addition, `packages/cli/test/help.test.ts` is expanded to verify help output for `task`, `permit`, and `hook`.

## Scope of Work
1. `docs/GUIDE.md`: Update `init` and `uninstall` command table rows to document `--yes`, `--no-input`, `--client`, and `--config`.
2. `packages/cli/README.md`: Reconcile `task`, `init`, and `uninstall` table rows with all flags and synopsis options.
3. `packages/cli/test/docs-tables.test.ts`: Expand `ROWS_NAME_EVERY_FLAG` to include `init`, `uninstall`, and `task`, locking their complete flag coverage into CI.
4. `packages/cli/test/help.test.ts`: Add test cases for `stroq task --help`, `stroq permit --help`, and `stroq hook --help`.

## Execution Order
- Task 1: Add implementation plan.
- Task 2: Reconcile `packages/cli/README.md`.
- Task 3: Reconcile `docs/GUIDE.md`.
- Task 4: Expand `packages/cli/test/docs-tables.test.ts` with `init`, `uninstall`, and `task`.
- Task 5: Add CLI help test cases in `packages/cli/test/help.test.ts`.
