import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import { applyPlan } from '../../src/harden/index.js';
import {
  BACKUPS_KEPT_PER_FILE,
  backupFile,
  backupPath,
  newBackupId,
  pruneBackups,
} from '../../src/harden/backup.js';
import type { Fs, HardenEnv } from '../../src/harden/types.js';
import { bytes, copiesOf, setup } from './backup-fixtures.js';
import { addDeny, engine, jsonText } from './engine-setup.js';
import { removeTempDirs, steppingClock, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/**
 * Which copies of a file are kept, and when the others go. The copies are the owner's way back, so
 * an old one is removed only once the change that made room for the new one has been made: pruning
 * for an apply that then fails would lose a copy for nothing.
 */
const idsFor = (count: number): string[] => {
  const clock = steppingClock();
  return Array.from({ length: count }, () => newBackupId(clock()));
};

/** What one successful apply does with a copy: stores it, and then prunes. */
async function keepCopy(env: HardenEnv, real: string, content: string, id: string): Promise<void> {
  await backupFile(env, real, bytes(content), id);
  await pruneBackups(env, real, id);
}

describe('pruneBackups: which five copies of a file are kept', () => {
  // The first copy is the file as it was before Stroq ever touched it. Keeping the newest five
  // would throw it away at the sixth apply, and with it the only way back to what the owner wrote.
  it('keeps the first copy and the newest four, and removes the ones between, with the directories they leave empty', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(7);

    for (const id of ids) await keepCopy(env, real, `copy ${id}`, id);

    expect(BACKUPS_KEPT_PER_FILE).toBe(5);
    expect(copiesOf(home, real)).toEqual([ids[0], ...ids.slice(3)]);
    expect(readdirSync(join(home, 'backups')).sort()).toEqual([ids[0], ...ids.slice(3)]);
    expect(readFileSync(backupPath(home, ids[0] ?? '', real), 'utf8')).toBe(`copy ${ids[0]}`);
    expect(readFileSync(backupPath(home, ids[6] ?? '', real), 'utf8')).toBe(`copy ${ids[6]}`);
  });

  it('keeps all of them while there are five or fewer', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(5);

    for (const id of ids) await keepCopy(env, real, 'x', id);

    expect(copiesOf(home, real)).toEqual(ids);
  });

  it('keeps the first copy however many come after it', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(25);

    for (const id of ids) await keepCopy(env, real, `copy ${id}`, id);

    expect(copiesOf(home, real)).toEqual([ids[0], ...ids.slice(-4)]);
    expect(readFileSync(backupPath(home, ids[0] ?? '', real), 'utf8')).toBe(`copy ${ids[0]}`);
  });

  it('keeps five per file, and never touches the copies of another file', async () => {
    const { home, real, env } = setup();
    const other = join(tempDir('other'), 'settings.json');
    const ids = idsFor(7);

    for (const id of ids.slice(0, 2)) await keepCopy(env, other, 'other', id);
    for (const id of ids) await keepCopy(env, real, 'this', id);

    expect(copiesOf(home, real)).toEqual([ids[0], ...ids.slice(3)]);
    expect(copiesOf(home, other)).toEqual(ids.slice(0, 2));
    // The directory of the third copy held nothing else, and is gone; the first two still hold
    // the other file’s copies.
    expect(readdirSync(join(home, 'backups')).sort()).toEqual(ids.filter((id) => id !== ids[2]));
  });

  it('never removes the copy it has just written, even if its id sorts oldest', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(6);
    for (const id of ids.slice(1)) await keepCopy(env, real, 'later', id);

    await keepCopy(env, real, 'earlier id', ids[0] ?? '');

    const kept = copiesOf(home, real);
    expect(kept).toHaveLength(5);
    expect(kept).toContain(ids[0]);
  });

  it('never removes the copy it has just written, even if its id sorts in the middle of the rest', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(9);
    const middle = ids[2] ?? '';
    for (const index of [0, 5, 6, 7, 8]) await keepCopy(env, real, 'copy', ids[index] ?? '');

    await keepCopy(env, real, 'between', middle);

    // The first copy, the four newest, and the one just written, which is neither.
    expect(copiesOf(home, real)).toEqual([ids[0], middle, ...ids.slice(5)]);
  });

  it('keeps going when it cannot remove an old copy', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(6);
    const fs: Fs = { ...nodeFs, unlink: () => Promise.reject(new Error('simulated EPERM')) };

    for (const id of ids) await keepCopy({ ...env, fs }, real, 'x', id);

    expect(copiesOf(home, real)).toEqual(ids);
  });

  it('does nothing, and says nothing, when there is no backups directory', async () => {
    const { env, real } = setup();

    await expect(pruneBackups(env, real, 'b1')).resolves.toBeUndefined();
  });
});

describe('backupFile: it stores, and removes nothing', () => {
  it('leaves every earlier copy where it was, however many there are', async () => {
    const { home, real, env } = setup();
    const ids = idsFor(8);

    for (const id of ids) await backupFile(env, real, bytes('x'), id);

    expect(copiesOf(home, real)).toEqual(ids);
  });
});

describe('applyPlan: a copy is removed only when the change was made', () => {
  /** Five applies of one file, so that the sixth has to make room for its copy. */
  async function fiveApplies() {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'm' }));
    for (const rule of ['a', 'b', 'c', 'd', 'e']) {
      await applyPlan(e.planJson('settings.json', [addDeny(rule)]), e.env);
    }
    const real = e.file('settings.json');
    return { e, real, before: copiesOf(e.home, real) };
  }

  it('prunes the oldest of the ones in between when the sixth apply goes through', async () => {
    const { e, real, before } = await fiveApplies();
    expect(before).toHaveLength(5);

    await applyPlan(e.planJson('settings.json', [addDeny('f')]), e.env);

    const after = copiesOf(e.home, real);
    expect(after).toHaveLength(5);
    expect(after[0]).toBe(before[0]);
    expect(after).not.toContain(before[1]);
  });

  it('removes nothing when the sixth apply fails to replace the file', async () => {
    const { e, real, before } = await fiveApplies();
    const plan = e.planJson('settings.json', [addDeny('f')]);
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) =>
        to === real
          ? Promise.reject(Object.assign(new Error('simulated EACCES'), { code: 'EACCES' }))
          : nodeFs.rename(from, to),
    };

    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toThrow(/EACCES/);

    // The copy the failed apply made is gone, and the five that were there are all still there.
    expect(copiesOf(e.home, real)).toEqual(before);
  });

  it('removes nothing when the file changed after the plan and the apply was refused', async () => {
    const { e, real, before } = await fiveApplies();
    const plan = e.planJson('settings.json', [addDeny('f')]);
    writeFileSync(real, jsonText({ model: 'the owner changed it' }));

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'stale-plan' });

    expect(copiesOf(e.home, real)).toEqual(before);
  });
});
