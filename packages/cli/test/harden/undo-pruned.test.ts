import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupPath } from '../../src/harden/backup.js';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import { addDeny, engine, jsonText, undo } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

/**
 * Only the first copy of a file and the four newest are kept, so after a few applies the record of
 * a middle one points at a copy that is gone. Undo does not need it: it takes that apply's entries
 * out of the file itself, and goes on to the copy of the first apply, which is the file as the
 * owner had it.
 */
describe('undoFile: records that point at copies that were pruned', () => {
  // An indent and a final newline that JSON.stringify's default does not make.
  const ORIGINAL = `${JSON.stringify({ model: 'm', theirs: [1, 2] }, null, 4)}\n`;

  async function appliedSeven() {
    const e = engine();
    writeFileSync(e.file('settings.json'), ORIGINAL);
    let real = '';
    for (let i = 1; i <= 7; i += 1) {
      const plan = e.planJson('settings.json', [addDeny(`Read(./secret-${i})`)]);
      real = plan.real;
      await applyPlan(plan, e.env);
    }
    return { e, real };
  }

  it('prunes the middle copies and keeps the first, so that there is something to go back to', async () => {
    const { e, real } = await appliedSeven();

    const entries = readManifest(e.env).files[real] ?? [];
    const present = entries.map(
      (entry) => entry.backup !== null && existsSync(backupPath(e.home, entry.backup, real)),
    );

    expect(entries).toHaveLength(7);
    expect(present).toEqual([true, false, false, true, true, true, true]);
  });

  it('gives back the owner’s file byte for byte, though two of the seven copies are gone', async () => {
    const { e, real } = await appliedSeven();

    const result = await undo(e, real);

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(ORIGINAL);
    expect(result).toMatchObject({ applications: 7, kept: [] });
    expect(result.status).toBe('surgical');
    expect(readManifest(e.env).files).toEqual({});
  });

  it('leaves no copy of this file behind that the records do not know about', async () => {
    const { e, real } = await appliedSeven();
    const known = new Set((readManifest(e.env).files[real] ?? []).map((entry) => entry.backup));

    const held = readdirSync(join(e.home, 'backups'));

    for (const id of held) expect(known.has(id)).toBe(true);
  });

  it('works the same when the owner has added to the file in between', async () => {
    const { e, real } = await appliedSeven();
    const current = JSON.parse(readFileSync(e.file('settings.json'), 'utf8')) as object;
    writeFileSync(
      e.file('settings.json'),
      `${JSON.stringify({ ...current, mine: true }, null, 4)}\n`,
    );

    await undo(e, real);

    expect(JSON.parse(readFileSync(e.file('settings.json'), 'utf8'))).toEqual({
      model: 'm',
      theirs: [1, 2],
      mine: true,
    });
  });
});
