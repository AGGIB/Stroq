import { join } from 'node:path';
import { readTargetText, writeFileAtomic } from '../../src/harden/atomic.js';
import { readBackup } from '../../src/harden/backup.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { readManifest } from '../../src/harden/manifest.js';

/**
 * Run by `fifo.test.ts` in a child process, never in the test runner: it points every reader the
 * engine has at a FIFO, which blocks forever for a reader that opens it plainly. If one of them
 * does, the parent's timeout kills this process and the test fails, where inside the runner the
 * same mistake would hang it.
 *
 * Prints one line of JSON: what each call did.
 */
const dir = process.argv[2];
if (dir === undefined) throw new Error('usage: fifo-child <dir>');

const REAL = '/stroq-fifo-test/settings.json';
const env = { home: join(dir, 'home'), now: () => new Date(0), version: 'x' };

const outcome = (run: () => unknown): string => {
  try {
    return `returned ${JSON.stringify(run())}`;
  } catch (err) {
    return `threw ${(err as { code?: string }).code ?? 'unknown'}`;
  }
};

const results: Record<string, string> = {
  readTargetText: outcome(() => readTargetText(join(dir, 'target'))),
  plan: outcome(() =>
    planJsonEdits(join(dir, 'target'), [{ kind: 'json-set', path: ['a'], value: 1 }], {
      read: readTargetText,
    }),
  ),
  readManifest: outcome(() => readManifest(env)),
  readBackup: outcome(() => readBackup(env, REAL, 'b1')),
};
results['writeFileAtomic'] = await writeFileAtomic(join(dir, 'target'), 'x').then(
  () => 'returned',
  (err: { code?: string }) => `threw ${err.code ?? 'unknown'}`,
);

console.log(JSON.stringify(results));
