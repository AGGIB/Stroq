import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Isolates every test file from the developer's real home directory before its
 * tests run: `os.homedir()` (used by `FileSecretIndex` via the CLI's
 * `engine-factory`/`doctor`/`canary` commands) honours `HOME` on POSIX and
 * `USERPROFILE` on Windows, so without this a test that only sets `STROQ_HOME`
 * would still read and hash the developer's real `~/.aws/credentials`,
 * `~/.npmrc`, etc. Individual tests may still override `HOME`/`STROQ_HOME` in
 * their own `beforeEach`, as `doctor.test.ts` does.
 */
const fakeHome = mkdtempSync(join(tmpdir(), 'stroq-home-'));
process.env['HOME'] = fakeHome;
process.env['USERPROFILE'] = fakeHome;
process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-stroq-home-'));

/**
 * Takes the wall clock out of every assertion that is about behaviour.
 *
 * The scanner fails CLOSED when its budget runs out — `timedOut` becomes `suspect`,
 * which taints the session — so on a loaded machine a benign fixture turns
 * suspicious and any test asserting `clean` fails. That is correct in production and
 * useless in a test: it reports how busy the machine is, not whether the code works.
 * Running 14 jobs across 10 cores made six unrelated tests fail this way, each in a
 * different file, which is what a flaky suite looks like from the outside.
 *
 * The tests that exercise the timeout itself pass an explicit `budgetMs`, which
 * takes precedence over this. Spawned CLI subprocesses inherit it, which is the only
 * reason the end-to-end hook tests are covered too.
 */
process.env['STROQ_SCAN_BUDGET_MS'] = String(10 * 60 * 1000);
