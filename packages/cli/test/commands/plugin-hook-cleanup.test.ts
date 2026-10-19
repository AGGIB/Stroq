import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { wrapper } from '../helpers/plugin-wrapper.js';

it.skipIf(process.platform === 'win32')(
  'only the parent wrapper removes its scratch directory',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'stroq-wrapper-cleanup-'));
    const work = join(root, 'scratch');
    mkdirSync(work);
    // A fast command can finish before its watchdog starts. Stopping that child can then
    // run the inherited EXIT trap. Exercise that cleanup deterministically, without timing.
    const cleanup = /^cleanup\(\) \{[\s\S]*?^\}/m.exec(readFileSync(wrapper, 'utf8'))?.[0];
    expect(cleanup).toBeDefined();
    try {
      const result = spawnSync(
        process.env['STROQ_TEST_BASH'] ?? 'bash',
        ['-c', `${cleanup}\nwork="$STROQ_TEST_WORK"\n(trap cleanup EXIT; exit 0)\ntest -d "$work"`],
        { env: { ...process.env, STROQ_TEST_WORK: work }, encoding: 'utf8' },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(work)).toBe(true);
      const parent = spawnSync(
        process.env['STROQ_TEST_BASH'] ?? 'bash',
        ['-c', `${cleanup}\nwork="$STROQ_TEST_WORK"\ntrap cleanup EXIT`],
        { env: { ...process.env, STROQ_TEST_WORK: work }, encoding: 'utf8' },
      );
      expect(parent.status, parent.stderr).toBe(0);
      expect(existsSync(work)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
