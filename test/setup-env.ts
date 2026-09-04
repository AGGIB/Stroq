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
