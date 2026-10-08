import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePrograms } from '../../src/actions/shell-input.js';
import { PAYLOAD, combinations } from './shell-matrix.js';

/**
 * Reading a command is a claim about what a shell would do with it, and the claim is checked here
 * against a shell: every command is run in a real bash with an `rm` that only writes down that it
 * ran, and a command whose payload ran must have been decoded, handed on as a file, or asked about.
 * A shell that is not there skips the test; so does Windows, which has none of these to run.
 */
const BASH = '/bin/bash';
const runnable = process.platform !== 'win32' && existsSync(BASH);

/** Every how-many-th command of the matrix is run: a spawn each, so the whole of it is for the CI that has time. */
const STRIDE = 7;
const SPAWN_TIMEOUT_MS = 4000;

let dir = '';
let record = '';

beforeAll(() => {
  if (!runnable) return;
  dir = mkdtempSync(join(tmpdir(), 'stroq-differential-'));
  mkdirSync(join(dir, 'bin'));
  record = join(dir, 'rm.log');
  // The fake `rm` and a `sudo` that only runs what it is given: nothing here is deleted or escalated.
  writeFileSync(join(dir, 'bin', 'rm'), '#!/bin/sh\necho "rm $*" >> "$RECORD"\n');
  writeFileSync(
    join(dir, 'bin', 'sudo'),
    '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n',
  );
  writeFileSync(join(dir, 'bin', 'flock'), '#!/bin/sh\nshift\nexec "$@"\n');
  writeFileSync(join(dir, 'bin', 'setsid'), '#!/bin/sh\nexec "$@"\n');
  for (const tool of ['rm', 'sudo', 'flock', 'setsid']) chmodSync(join(dir, 'bin', tool), 0o755);
  writeFileSync(join(dir, 'x.sh'), `${PAYLOAD}\n`);
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function ran(command: string): boolean {
  rmSync(record, { force: true });
  spawnSync(BASH, ['-c', command], {
    cwd: dir,
    env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, RECORD: record, HOME: dir, TMPDIR: dir },
    input: '',
    timeout: SPAWN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return existsSync(record) && readFileSync(record, 'utf8').includes('rm -rf');
}

describe.skipIf(!runnable)('what a real bash runs, against what is read', () => {
  it('is decoded, handed on as a file, or asked about, whenever the payload ran', () => {
    let executed = 0;
    const missed: string[] = [];
    for (const command of combinations(STRIDE)) {
      if (!ran(command)) continue;
      executed += 1;
      const input = decodePrograms(command, undefined);
      const caught =
        input.opaque ||
        input.texts.some((text) => text.includes(PAYLOAD)) ||
        input.files.some((file) => file.endsWith('x.sh'));
      if (!caught) missed.push(command);
    }
    // The commands that do not run in bash (a spelling of a shell that is not one there) say nothing.
    expect(executed).toBeGreaterThan(50);
    expect(missed).toEqual([]);
  }, 600_000);
});
