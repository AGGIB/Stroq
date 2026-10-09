import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { backupPath } from '../../src/harden/backup.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const CLI_PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fifo-child.ts', import.meta.url));
const REAL = '/stroq-fifo-test/settings.json';
/** Many times what the child needs to start and run, and under the runner's own 30 s. */
const CHILD_TIMEOUT_MS = 25_000;

/**
 * A FIFO where an agent config, the manifest or a copy should be is the one file that makes a
 * plain `open` wait forever. Everything the engine reads must refuse it without waiting, and the
 * proof that it does must not be able to hang the test run: the readers run in a child process
 * that is killed when the timeout passes.
 */
describe.skipIf(process.platform === 'win32')('a FIFO where a file should be', () => {
  it('is refused by every reader and writer of the engine, without waiting for anyone', () => {
    const dir = tempDir('fifo');
    const home = join(dir, 'home');
    mkdirSync(join(home, 'harden'), { recursive: true });
    mkdirSync(join(home, 'backups', 'b1'), { recursive: true });
    execFileSync('mkfifo', [join(dir, 'target')]);
    execFileSync('mkfifo', [join(home, 'harden', 'manifest.json')]);
    execFileSync('mkfifo', [backupPath(home, 'b1', REAL)]);

    const child = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir], {
      cwd: CLI_PACKAGE,
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    // A child that was killed for taking too long has `signal` set and no output.
    expect({ signal: child.signal, status: child.status, stderr: child.stderr }).toEqual({
      signal: null,
      status: 0,
      stderr: '',
    });
    expect(JSON.parse(child.stdout)).toEqual({
      readTargetText: 'threw not-regular-file',
      plan: 'threw not-regular-file',
      readManifest: 'threw manifest-unsafe',
      readBackup: 'returned null',
      writeFileAtomic: 'threw not-regular-file',
    });
  });
});
