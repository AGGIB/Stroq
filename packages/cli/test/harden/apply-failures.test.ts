import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import { applyPlan, undoFile } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { Fs, Plan } from '../../src/harden/types.js';
import { addDeny, engine, jsonText } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

/** Fails the rename that puts a file whose name ends in `suffix` in place. */
const failingRename = (suffix: string): Fs => ({
  ...nodeFs,
  rename: (from, to) =>
    to.endsWith(suffix)
      ? Promise.reject(new Error(`simulated trouble with ${suffix}`))
      : nodeFs.rename(from, to),
});

const leftovers = (dir: string): string[] =>
  readdirSync(dir).filter((name) => name.endsWith('.tmp'));

describe('applyPlan: a manifest it cannot trust', () => {
  it('refuses before it keeps a copy or touches the file, when the manifest is not one it can read', async () => {
    const { env, file, home, planJson } = engine();
    const before = jsonText({ a: 1 });
    writeFileSync(file('settings.json'), before);
    mkdirSync(join(home, 'harden'), { recursive: true });
    writeFileSync(join(home, 'harden', 'manifest.json'), '{"version": 1, "files": "no"}');
    const plan = planJson('settings.json', [addDeny('x')]);

    await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'manifest-invalid' });

    expect(readFileSync(file('settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, 'backups'))).toBe(false);
    expect(readFileSync(join(home, 'harden', 'manifest.json'), 'utf8')).toBe(
      '{"version": 1, "files": "no"}',
    );
  });
});

describe('applyPlan: when something fails', () => {
  it('leaves the file as it was, with no temporary file and no entry, when the rename fails', async () => {
    const { env, file, home, project, planJson } = engine();
    const before = jsonText({ a: 1 });
    writeFileSync(file('settings.json'), before);
    const plan = planJson('settings.json', [addDeny('x')]);

    await expect(applyPlan(plan, { ...env, fs: failingRename('settings.json') })).rejects.toThrow(
      /trouble with settings\.json/,
    );

    expect(readFileSync(file('settings.json'), 'utf8')).toBe(before);
    expect(leftovers(project)).toEqual([]);
    expect(readManifest(env).files).toEqual({});
    expect(existsSync(join(home, 'harden', 'manifest.json'))).toBe(false);
  });

  it('leaves the file alone when it cannot record what it is about to do', async () => {
    const { env, file, home, planJson } = engine();
    const before = jsonText({ a: 1 });
    writeFileSync(file('settings.json'), before);
    const plan = planJson('settings.json', [addDeny('x')]);

    await expect(applyPlan(plan, { ...env, fs: failingRename('manifest.json') })).rejects.toThrow(
      /trouble with manifest\.json/,
    );

    expect(readFileSync(file('settings.json'), 'utf8')).toBe(before);
    expect(leftovers(join(home, 'harden'))).toEqual([]);
  });

  it('puts the manifest back as it was when the write fails, and the failure it reports is the write’s', async () => {
    const { env, file, planJson } = engine();
    writeFileSync(file('settings.json'), '{}\n');
    await applyPlan(planJson('settings.json', [addDeny('a')]), env);
    const manifestBefore = readFileSync(join(env.home, 'harden', 'manifest.json'), 'utf8');
    const plan = planJson('settings.json', [addDeny('b')]);

    await expect(applyPlan(plan, { ...env, fs: failingRename('settings.json') })).rejects.toThrow(
      /trouble with settings\.json/,
    );

    expect(readFileSync(join(env.home, 'harden', 'manifest.json'), 'utf8')).toBe(manifestBefore);
  });

  it('reports the write’s failure, not the failure to put the manifest back after it', async () => {
    const { env, file, planJson } = engine();
    const before = jsonText({ a: 1 });
    writeFileSync(file('settings.json'), before);
    const plan = planJson('settings.json', [addDeny('x')]);
    let renames = 0;
    const fs: Fs = {
      ...nodeFs,
      // The copy and the manifest go in; the file does not, and neither does the manifest again.
      rename: (from, to) =>
        (renames += 1) <= 2
          ? nodeFs.rename(from, to)
          : Promise.reject(new Error('simulated write failure')),
      unlink: () => Promise.reject(new Error('simulated manifest rollback failure')),
    };

    await expect(applyPlan(plan, { ...env, fs })).rejects.toThrow(/simulated write failure/);
    expect(readManifest(env).files[plan.real]).toHaveLength(1);

    expect(readFileSync(file('settings.json'), 'utf8')).toBe(before);
    // The entry could not be taken back, and undo says there was nothing to take out.
    const undone = await undoFile(env, file('settings.json'));
    expect(undone.status).toBe('already-undone');
    expect(readFileSync(file('settings.json'), 'utf8')).toBe(before);
  });

  it('removes directories created for a new file when the file write fails', async () => {
    const { env, file, planJson } = engine();
    const plan = planJson('deep/nested/sub/settings.json', [addDeny('x')]);
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) =>
        to.endsWith('settings.json')
          ? Promise.reject(new Error('simulated disk failure'))
          : nodeFs.rename(from, to),
    };

    await expect(applyPlan(plan, { ...env, fs })).rejects.toThrow(/simulated disk failure/);

    expect(existsSync(file('deep/nested/sub'))).toBe(false);
    expect(existsSync(file('deep/nested'))).toBe(false);
    expect(existsSync(file('deep'))).toBe(false);
  });

  it.skipIf(onWindows)(
    'leaves a read-only file as it is and does not leave a record of it',
    async () => {
      const { env, file, planJson } = engine();
      writeFileSync(file('settings.json'), '{}\n');
      chmodSync(file('settings.json'), 0o444);
      const plan = planJson('settings.json', [addDeny('x')]);

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'read-only-target' });

      expect(readFileSync(file('settings.json'), 'utf8')).toBe('{}\n');
      expect(readManifest(env).files).toEqual({});
    },
  );
});

describe('applyPlan: several at once', () => {
  it('records every one of applies on different files made at the same moment', async () => {
    const { env, file, planJson } = engine();
    const names = Array.from({ length: 8 }, (_, i) => `settings-${i}.json`);
    for (const name of names) writeFileSync(file(name), '{}\n');
    const plans: Plan[] = names.map((name) => planJson(name, [addDeny(name)]));

    await Promise.all(plans.map((plan) => applyPlan(plan, env)));

    expect(Object.keys(readManifest(env).files).sort()).toEqual(names.map(file).sort());
    for (const [i, name] of names.entries()) {
      expect(readFileSync(file(name), 'utf8')).toBe(plans[i]?.after);
    }
  });

  it('lets one of two plans made from the same file win, and refuses the other', async () => {
    const { env, file, planJson } = engine();
    writeFileSync(file('settings.json'), '{}\n');
    const first = planJson('settings.json', [addDeny('first')]);
    const second = planJson('settings.json', [addDeny('second')]);

    const outcomes = await Promise.allSettled([applyPlan(first, env), applyPlan(second, env)]);

    const settled = outcomes.map((outcome) => outcome.status).sort();
    expect(settled).toEqual(['fulfilled', 'rejected']);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'stale-plan' } });
    const written = readFileSync(file('settings.json'), 'utf8');
    expect([first.after, second.after]).toContain(written);
    expect(readManifest(env).files[file('settings.json')]).toHaveLength(1);
  });
});
