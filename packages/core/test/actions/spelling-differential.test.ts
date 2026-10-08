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
import { classifyTool } from '../../src/actions/classify-tool.js';
import { spellings } from './spelling-matrix.js';

/**
 * The spellings in `spelling-matrix.ts` are said to be commands that run. This runs them: each in a
 * real bash and a real zsh, with an `rm` that only writes down that it was called, and a command
 * whose `rm -rf ~` ran must have been classified as destructive or asked about. A shell that is not
 * there skips its part; so does Windows, which has none of these to run.
 */
const SHELLS = ['/bin/bash', '/bin/zsh'].filter(
  (shell) => process.platform !== 'win32' && existsSync(shell),
);
const SPAWN_TIMEOUT_MS = 4000;
const CPU_LIMIT_SECONDS = 3;
const PAYLOAD = 'rm -rf ~';

let dir = '';
let home = '';
let record = '';

beforeAll(() => {
  if (SHELLS.length === 0) return;
  dir = mkdtempSync(join(tmpdir(), 'stroq-spelling-'));
  // The home is a directory of its own: where a real `rm -rf ~` is reached by a spelling that does
  // not find the fake one, it removes this and nothing else.
  home = join(dir, 'home');
  mkdirSync(home);
  mkdirSync(join(dir, 'bin'));
  record = join(dir, 'rm.log');
  writeFileSync(join(dir, 'bin', 'rm'), '#!/bin/sh\necho "rm $*" >> "$RECORD"\n');
  // A `sudo` that only runs what it is given, and a `bash` and `sh` that are the real ones.
  writeFileSync(
    join(dir, 'bin', 'sudo'),
    '#!/bin/sh\nwhile [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"\n',
  );
  for (const tool of ['rm', 'sudo']) chmodSync(join(dir, 'bin', tool), 0o755);
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

function ran(shell: string, command: string): boolean {
  rmSync(record, { force: true });
  // A spelling may loop for ever (the fake `rm` always succeeds), and killing the shell does not kill
  // what it started: a CPU limit, which children inherit, does.
  spawnSync(
    '/bin/sh',
    ['-c', `ulimit -t ${CPU_LIMIT_SECONDS}; exec "$0" -c "$1"`, shell, command],
    {
      cwd: dir,
      env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, RECORD: record, HOME: home, TMPDIR: dir },
      input: '',
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  return existsSync(record) && readFileSync(record, 'utf8').includes('rm -rf');
}

describe.skipIf(SHELLS.length === 0)('what a real shell runs, against what is classified', () => {
  // A spelling that names the real `rm` by its path does not call the fake one.
  const commands = spellings(PAYLOAD).filter((command) => !command.includes('/usr/bin/'));

  it.each(SHELLS)(
    'in %s: every spelling that ran the payload was classified or asked about',
    (shell) => {
      let executed = 0;
      const missed: string[] = [];
      for (const command of commands) {
        if (!ran(shell, command)) continue;
        executed += 1;
        const { classes } = classifyTool('Bash', { command }, dir);
        if (!classes.includes('shell.destructive') && !classes.includes('shell.unparsed'))
          missed.push(command);
      }
      // The spellings a shell does not accept (`coproc` in some, `time(` in others) say nothing.
      expect(executed).toBeGreaterThan(100);
      expect(missed).toEqual([]);
    },
    600_000,
  );
});
