import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs } from '../../src/harden/atomic.js';
import { backupPath } from '../../src/harden/backup.js';
import { applyPlan, undoFile } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { Fs } from '../../src/harden/types.js';
import { IGNORE_ID, addDeny, applied, engine, jsonText, undo } from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

describe('undoFile: the copy', () => {
  it('falls back to taking the entries out when the copy has gone', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    const { result: made, real, path } = await applied(e, 'settings.json', before, [addDeny('a')]);
    rmSync(backupPath(e.home, made.backup?.id ?? '', real));

    const result = await undo(e, real);

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(result.status).toBe('surgical');
  });

  // The copy is a file in a directory anyone who is the owner can write; it is trusted only if it
  // is exactly the bytes the manifest says were there.
  it('does not use a copy that is not the file it was made from', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    const { result: made, real, path } = await applied(e, 'settings.json', before, [addDeny('a')]);
    writeFileSync(backupPath(e.home, made.backup?.id ?? '', real), jsonText({ planted: 'bytes' }));

    const result = await undo(e, real);

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readFileSync(path, 'utf8')).not.toContain('planted');
    expect(result.status).toBe('surgical');
  });
});

describe('undoFile: when there is nothing to undo, or it cannot be done', () => {
  it('is a no-op the second time, and the third', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    const { real, path } = await applied(e, 'settings.json', before, [addDeny('a')]);
    await undo(e, real);

    for (let run = 0; run < 2; run += 1) {
      const again = await undo(e, real);
      expect(again).toMatchObject({
        status: 'already-undone',
        diff: '',
        kept: [],
        applications: 0,
      });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });

  // The manifest is an object keyed by what the caller names; some names are also properties of
  // every object.
  it.each(['__proto__', 'constructor', 'toString'])(
    'finds no entry for a path called %s, not an entry that is not one',
    async (name) => {
      const e = engine();
      await applied(e, 'settings.json', jsonText({ model: 'm' }), [addDeny('a')]);

      const result = await undoFile(e.env, name, { root: e.project });

      expect(result).toMatchObject({ status: 'already-undone', applications: 0 });
      expect(Object.keys(readManifest(e.env).files)).toEqual([e.file('settings.json')]);
    },
  );

  it('says there is nothing to undo for a file Stroq never changed', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), '{}\n');

    const result = await undo(e, e.file('settings.json'));

    expect(result).toMatchObject({ status: 'already-undone', applications: 0 });
    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe('{}\n');
  });

  it('is a no-op when all that was applied was already there', async () => {
    const e = engine();
    const before = jsonText({ permissions: { deny: ['a'] } });
    const { result: made, real } = await applied(e, 'settings.json', before, [addDeny('a')]);
    expect(made.changed).toBe(false);

    const result = await undo(e, real);

    expect(result.status).toBe('already-undone');
    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(before);
  });

  it.skipIf(onWindows)('finds the entry from the path of a link to the file', async () => {
    const e = engine();
    const real = join(e.project, 'dotfiles', 'settings.json');
    mkdirSync(dirname(real), { recursive: true });
    const before = jsonText({ model: 'm' });
    writeFileSync(real, before);
    symlinkSync(real, e.file('settings.json'));
    await applyPlan(e.planJson('settings.json', [addDeny('a')]), e.env);

    const result = await undo(e, e.file('settings.json'));

    expect(readFileSync(real, 'utf8')).toBe(before);
    expect(result.real).toBe(real);
    expect(lstatSync(e.file('settings.json')).isSymbolicLink()).toBe(true);
  });

  describe('a file the entries cannot be taken out of', () => {
    it('is left exactly as it is, with the entries kept, when it has since got a comment', async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
        addDeny('a'),
      ]);
      const commented = readFileSync(path, 'utf8').replace('{', '{\n  // my note');
      writeFileSync(path, commented);

      const result = await undo(e, real);

      expect(result.status).toBe('blocked');
      expect(result.blocked).toMatchObject({ refused: 'jsonc' });
      expect(result.diff).toBe('');
      expect(readFileSync(path, 'utf8')).toBe(commented);
      expect(readManifest(e.env).files[real]).toHaveLength(1);

      // The owner takes the comment out, and the same undo goes through.
      writeFileSync(path, commented.replace('\n  // my note', ''));
      const later = await undo(e, real);
      expect(later.status).not.toBe('blocked');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'm' });
      expect(readManifest(e.env).files).toEqual({});
    });

    it('is left alone when a block’s markers are no longer a pair', async () => {
      const e = engine();
      writeFileSync(e.file('.cursorignore'), 'node_modules/\n');
      const plan = e.planBlock('.cursorignore');
      await applyPlan(plan, e.env);
      const damaged = readFileSync(e.file('.cursorignore'), 'utf8').replace(
        `<<< stroq harden: ${IGNORE_ID}`,
        'oops',
      );
      writeFileSync(e.file('.cursorignore'), damaged);

      const result = await undo(e, plan.real);

      expect(result).toMatchObject({ status: 'blocked', blocked: { refused: 'markers-damaged' } });
      expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe(damaged);
      expect(readManifest(e.env).files[plan.real]).toHaveLength(1);
    });
  });

  it('leaves the file as it is and keeps the entries when the write fails', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    const afterApply = readFileSync(path, 'utf8');
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) =>
        to.endsWith('settings.json')
          ? Promise.reject(new Error('simulated trouble'))
          : nodeFs.rename(from, to),
    };

    await expect(undoFile({ ...e.env, fs }, real, { root: e.project })).rejects.toThrow(
      /simulated trouble/,
    );

    expect(readFileSync(path, 'utf8')).toBe(afterApply);
    expect(readdirSync(e.project).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it.skipIf(onWindows)(
    'refuses to write through a link that now leads out of the root',
    async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
        addDeny('a'),
      ]);
      const victim = join(tempDir('outside'), 'victim.json');
      writeFileSync(victim, jsonText({ victim: true }));
      unlinkSync(path);
      symlinkSync(victim, path);

      await expect(undoFile(e.env, path, { root: e.project })).rejects.toMatchObject({
        code: 'path-escapes-root',
      });

      expect(readFileSync(victim, 'utf8')).toBe(jsonText({ victim: true }));
      expect(readManifest(e.env).files[real]).toHaveLength(1);
    },
  );
});
