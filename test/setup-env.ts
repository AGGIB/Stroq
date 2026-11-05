import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll } from 'vitest';

/** The system's temporary folder, read once before this file points the variables at a folder of its own. */
const systemTmp = tmpdir();

/**
 * One temporary folder for each test file, removed when the file is done, where the run has none of its
 * own. Every `tmpdir()` in the file and in the processes it starts lands in it (TMPDIR on POSIX, TEMP and
 * TMP on Windows), so the hundreds of folders a test file makes go with it instead of piling up in the
 * shared temporary folder: a few runs of a config without the global setup left tens of thousands of
 * `stroq-*` folders behind and filled the disk of the machine running them.
 *
 * A run started through `global-setup.ts` already has a folder of its own (`stroq-test-run-…`) that it
 * removes at the end, and is left as it is: a folder inside it would make every path in the tests 18
 * characters longer, which put a read's file name past the 120 characters a provenance record keeps and
 * a socket's path past the 104 bytes macOS allows.
 */
const fileTmp = basename(systemTmp).startsWith('stroq-test-run-')
  ? null
  : mkdtempSync(join(systemTmp, 'stroq-test-'));
if (fileTmp !== null) {
  process.env['TMPDIR'] = fileTmp;
  process.env['TEMP'] = fileTmp;
  process.env['TMP'] = fileTmp;
  afterAll(() => {
    try {
      rmSync(fileTmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A file a process still holds open (Windows) stays behind; the test result does not depend on it.
    }
  });
}

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
// Cursor reads APPDATA on Windows even when USERPROFILE is isolated. Never inspect
// the developer's real state.vscdb while looking for a fixture session.
process.env['APPDATA'] = join(fakeHome, 'AppData', 'Roaming');
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

/**
 * One compile cache for every CLI the tests start, in the run's own temporary directory.
 *
 * The CLI keeps its compiled code under the Stroq home it runs with (`compile-cache.ts`), and the
 * tests give almost every spawn a home of its own: each would compile the whole bundle cold and
 * write a few megabytes that nothing reads again, hundreds of times in a run. With this variable
 * set Node turns the cache on in this folder before the CLI starts, and the CLI keeps it, as it
 * would for a user who set it. `compile-cache.test.ts` starts the CLI without it, to check its own.
 */
process.env['NODE_COMPILE_CACHE'] ??= join(systemTmp, 'stroq-tests-compile-cache');
