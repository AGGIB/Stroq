import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';

afterEach(removeTempRoots);

const CLI_PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./read-dir-child.ts', import.meta.url));
/** Many times what the child needs to start and run, and under the runner's own 30 s. */
const CHILD_TIMEOUT_MS = 25_000;

interface ChildOutcome {
  readonly paths?: readonly string[];
  readonly blindSpots?: readonly string[];
  readonly refused?: string;
  readonly message?: string;
}

/** Runs the reader on `dir` in a child that is killed if it waits for anyone. */
function readInChild(dir: string): ChildOutcome {
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
  return JSON.parse(child.stdout) as ChildOutcome;
}

describe.skipIf(process.platform === 'win32')('a FIFO where a file should be', () => {
  it('is not opened, and is left out with a blind spot that does not name it', () => {
    const root = tempRoot();
    writeFiles(root, { 'ok.txt': 'ok' });
    execFileSync('mkfifo', [join(root, 'pipe-name-that-must-not-be-echoed')]);

    const outcome = readInChild(root);

    expect(outcome.paths).toEqual(['ok.txt']);
    const spots = outcome.blindSpots ?? [];
    expect(spots.some((spot) => spot.includes('special file'))).toBe(true);
    expect(JSON.stringify(spots)).not.toContain('pipe-name');
  });

  it('is counted, wherever it is and however many there are', () => {
    const root = tempRoot();
    writeFiles(root, { 'sub/ok.txt': 'ok' });
    execFileSync('mkfifo', [join(root, 'one')]);
    execFileSync('mkfifo', [join(root, 'sub', 'two')]);

    const outcome = readInChild(root);

    expect(outcome.paths).toEqual(['sub/ok.txt']);
    expect((outcome.blindSpots ?? []).join(' ')).toContain('2 special files');
  });

  it('is refused as the folder to read, without waiting for a writer', () => {
    const root = tempRoot();
    const fifo = join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);

    const outcome = readInChild(fifo);

    expect(outcome.refused).toBe('not-a-directory');
  });
});
