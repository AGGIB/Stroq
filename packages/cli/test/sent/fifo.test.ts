import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_PACKAGE = fileURLToPath(new URL('../..', import.meta.url));
const CHILD = fileURLToPath(new URL('./fifo-child.ts', import.meta.url));
/** Many times what the child needs to start and run, and under the runner's own 30 s. */
const CHILD_TIMEOUT_MS = 25_000;

/**
 * The folders sessions ran in are named by the session, and what is in them by the repository or
 * the agent. A FIFO named `.env.x`, `.mcp.json` or `.git/config` there makes a plain `open` wait
 * forever, and `stroq sent` would never print its report. Every reader must refuse it at once,
 * and count a key file it could not read. The readers run in a child process that is killed when
 * the timeout passes, so a reader that waits fails the test instead of hanging the run.
 */
describe.skipIf(process.platform === 'win32')(
  'stroq sent and a FIFO where a file should be',
  () => {
    it('refuses it in every reader, without waiting, and counts the key file as unreadable', () => {
      const dir = mkdtempSync(join(tmpdir(), 'stroq-sent-fifo-'));
      const project = join(dir, 'project');
      const stroq = join(dir, 'stroq');
      mkdirSync(join(project, '.git'), { recursive: true });
      mkdirSync(join(dir, 'home'), { recursive: true });
      mkdirSync(stroq, { recursive: true });
      writeFileSync(join(project, '.env'), 'API_KEY=FAKEfifoProjectKey0123456789\n');
      for (const name of ['.env.fifo', '.mcp.json', join('.git', 'config')])
        execFileSync('mkfifo', [join(project, name)]);
      // A decoy file `stroq canary` lists can be a FIFO too.
      const decoy = join(dir, 'decoy.env');
      execFileSync('mkfifo', [decoy]);
      writeFileSync(join(stroq, 'canary-files.json'), JSON.stringify({ files: [decoy] }));

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
        keys: ['API_KEY'],
        // The FIFO `.env.fifo` and the decoy: files that exist but could not be read.
        unreadable: 2,
        mcp: [],
        gitRemote: null,
        scanFailed: true,
        canaries: 0,
        head: false,
      });
    });
  },
);
