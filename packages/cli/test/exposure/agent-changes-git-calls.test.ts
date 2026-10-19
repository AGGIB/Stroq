import * as childProcess from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { commitFiles, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * How many git processes one check starts. A change that edits thousands of agent files must not
 * start one process per file to read what each held at the base: the old contents are read in
 * batches, like the new ones, and every call to git has a time limit.
 */
const calls = vi.hoisted(() => ({ list: [] as { args: string[]; timeout: unknown }[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((file: string, args: string[], options: { timeout?: unknown }) => {
      if (file === 'git') calls.list.push({ args: [...args], timeout: options?.timeout });
      return (actual.execFileSync as (...a: unknown[]) => unknown)(file, args, options);
    }) as typeof actual.execFileSync,
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  calls.list = [];
});

describe('the git processes of one --changed-from check', () => {
  it('reads the base of 300 edited files in a few processes, each with a time limit', () => {
    const dir = scratchRepo(dirs);
    const hooks = (n: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: 300 }, (_, i) => [
          `.github/hooks/h${i}.json`,
          JSON.stringify({ hooks: { Stop: [{ command: `./s${i}-${n}.sh` }] } }),
        ]),
      );
    const base = commitFiles(dir, hooks(1));
    commitFiles(dir, hooks(2));
    calls.list = [];
    const changes = agentChanges(dir, base);
    expect(changes.hits.filter((h) => h.status === 'changed')).toHaveLength(300);
    const ours = calls.list.filter((c) => c.args.includes('cat-file'));
    expect(ours.length).toBeLessThanOrEqual(4);
    expect(calls.list.every((c) => typeof c.timeout === 'number' && c.timeout > 0)).toBe(true);
    expect(childProcess.execFileSync).toBeDefined();
  });
});
