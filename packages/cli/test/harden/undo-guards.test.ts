import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFs, readTargetText } from '../../src/harden/atomic.js';
import { DIFF_OMITTED_NOTICE, applyPlan, undoFile } from '../../src/harden/index.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { readManifest } from '../../src/harden/manifest.js';
import type { Fs } from '../../src/harden/types.js';
import { addDeny, applied, engine, jsonText, owner, setSandbox, undo } from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';
import { signedText } from './manifest-fixtures.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';

describe('what apply records of where it wrote', () => {
  it('names the real path and the root the plan was made for', async () => {
    const e = engine();
    const { real } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [addDeny('a')]);

    const [recorded] = readManifest(e.env).files[real] ?? [];

    expect(recorded).toMatchObject({ real, root: e.project });
  });

  it('records no root when the plan was made without one', async () => {
    const e = engine();
    writeFileSync(e.file('settings.json'), jsonText({ model: 'm' }));
    const plan = planJsonEdits(e.file('settings.json'), [addDeny('a')], { read: readTargetText });
    expect(plan.root).toBeUndefined();

    await applyPlan(plan, e.env);

    const [recorded] = readManifest(e.env).files[plan.real] ?? [];
    expect(recorded?.root).toBeNull();
  });

  it.skipIf(onWindows)('records the real path of a file reached through a link', async () => {
    const e = engine();
    const real = join(e.project, 'dotfiles', 'settings.json');
    mkdirSync(join(e.project, 'dotfiles'), { recursive: true });
    writeFileSync(real, jsonText({ model: 'm' }));
    symlinkSync(real, e.file('settings.json'));

    await applyPlan(e.planJson('settings.json', [addDeny('a')]), e.env, { acknowledgeLink: true });

    expect(Object.keys(readManifest(e.env).files)).toEqual([real]);
    expect(readManifest(e.env).files[real]?.[0]?.real).toBe(real);
  });
});

describe.skipIf(onWindows)('undoFile: the recorded path now leads somewhere else', () => {
  /** Applied once, with the project as the root; `after` is what Stroq left in the file. */
  async function appliedOnce() {
    const e = engine();
    const made = await applied(e, 'settings.json', jsonText({ model: 'm' }), [addDeny('a')]);
    return { e, ...made, after: made.plan.after };
  }

  it('refuses a link that leaves the recorded root even when the caller names none', async () => {
    const { e, real, path, after } = await appliedOnce();
    const victim = join(tempDir('outside'), 'victim.json');
    // Exactly what Stroq left: undo, believing the file is its own, would put the old bytes back.
    writeFileSync(victim, after);
    unlinkSync(path);
    symlinkSync(victim, path);

    await expect(undoFile(e.env, real)).rejects.toMatchObject({ code: 'path-escapes-root' });

    expect(readFileSync(victim, 'utf8')).toBe(after);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it('refuses a link that leaves the root the caller names', async () => {
    const { e, real, path, after } = await appliedOnce();
    const victim = join(tempDir('outside'), 'victim.json');
    writeFileSync(victim, after);
    unlinkSync(path);
    symlinkSync(victim, path);

    await expect(undoFile(e.env, real, { root: e.project })).rejects.toMatchObject({
      code: 'path-escapes-root',
    });

    expect(readFileSync(victim, 'utf8')).toBe(after);
  });

  it('refuses a link to another file inside the root: that is not the file Stroq edited', async () => {
    const { e, real, path, after } = await appliedOnce();
    const other = e.file('other.json');
    writeFileSync(other, after);
    unlinkSync(path);
    symlinkSync(other, path);

    const error = await undo(e, real).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'path-changed' });
    expect((error as Error).message).toContain(real);
    expect(readFileSync(other, 'utf8')).toBe(after);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it('refuses when a directory in the recorded path has become a link', async () => {
    const e = engine();
    mkdirSync(e.file('sub'), { recursive: true });
    const { real, plan } = await applied(e, 'sub/settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    renameSync(e.file('sub'), e.file('moved'));
    symlinkSync(e.file('moved'), e.file('sub'));

    await expect(undo(e, real)).rejects.toMatchObject({ code: 'path-changed' });

    expect(readFileSync(join(e.file('moved'), 'settings.json'), 'utf8')).toBe(plan.after);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it('still undoes through the path it was asked by, when that is a link to the recorded file', async () => {
    const e = engine();
    const real = join(e.project, 'dotfiles', 'settings.json');
    mkdirSync(join(e.project, 'dotfiles'), { recursive: true });
    const before = jsonText({ model: 'm' });
    writeFileSync(real, before);
    symlinkSync(real, e.file('settings.json'));
    await applyPlan(e.planJson('settings.json', [addDeny('a')]), e.env, { acknowledgeLink: true });

    const result = await undo(e, e.file('settings.json'));

    expect(result.status).toBe('restored');
    expect(readFileSync(real, 'utf8')).toBe(before);
  });

  it('refuses a link that points nowhere where the file was', async () => {
    const { e, real, path } = await appliedOnce();
    unlinkSync(path);
    symlinkSync(join(e.project, 'nowhere.json'), path);

    await expect(undo(e, real)).rejects.toMatchObject({ code: 'dangling-link' });

    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });
});

describe('undoFile: a record that is not about the path it is under', () => {
  it('is refused as a manifest that is not what Stroq writes', async () => {
    const e = engine();
    const { real } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [addDeny('a')]);
    const other = e.file('other.json');
    writeFileSync(other, jsonText({ model: 'o' }));
    const manifestFile = join(e.home, 'harden', 'manifest.json');
    // The entry for settings.json, filed under other.json.
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      files: Record<string, unknown>;
    };
    // Signed by this home, so that what is refused is the record, not its signature.
    writeFileSync(manifestFile, signedText(e.home, { [other]: manifest.files[real] }));

    await expect(undo(e, other)).rejects.toMatchObject({ code: 'manifest-invalid' });

    expect(readFileSync(other, 'utf8')).toBe(jsonText({ model: 'o' }));
  });
});

describe('undoFile: a record that mixes JSON edits and text edits', () => {
  it('is blocked and untouched, since no file is both', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    const after = readFileSync(path, 'utf8');
    const manifestFile = join(e.home, 'harden', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      files: Record<string, { edits: unknown[] }[]>;
    };
    manifest.files[real]?.[0]?.edits.push({
      kind: 'text-block',
      id: 'cursor-ignore',
      lines: ['.env'],
      previous: null,
      prefix: '',
      closesLastLine: false,
      suffix: '\n',
    });
    writeFileSync(manifestFile, signedText(e.home, manifest.files));
    // Not what Stroq left, so that the copy is not simply put back.
    owner(path, (doc) => ({ ...doc, theirs: 1 }));

    const result = await undo(e, real);

    expect(result).toMatchObject({ status: 'blocked', blocked: { refused: 'type-conflict' } });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ theirs: 1 });
    expect(after).toContain('"deny"');
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });
});

describe('apply: a link that points nowhere at the target', () => {
  it.skipIf(onWindows)('is refused before anything is made or kept', async () => {
    const e = engine();
    writeFileSync(e.file('real.json'), jsonText({ model: 'm' }));
    symlinkSync(e.file('real.json'), e.file('settings.json'));
    const plan = e.planJson('settings.json', [addDeny('a')]);
    expect(plan.refused).toBeUndefined();
    // The link is re-pointed after the plan was made.
    unlinkSync(e.file('settings.json'));
    symlinkSync(join(e.project, 'nowhere', 'file.json'), e.file('settings.json'));

    await expect(applyPlan(plan, e.env)).rejects.toMatchObject({ code: 'dangling-link' });

    expect(existsSync(join(e.project, 'nowhere'))).toBe(false);
    expect(existsSync(join(e.home, 'harden'))).toBe(false);
    expect(existsSync(join(e.home, 'backups'))).toBe(false);
  });
});

describe('undoFile: a file that is not valid UTF-8 now', () => {
  const NOT_UTF8 = Buffer.from([0xc3, 0x28]);

  it('is left byte for byte as it is, for a JSON file', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    const bytes = Buffer.concat([
      Buffer.from('{"permissions":{"deny":["a"]},"note":"'),
      NOT_UTF8,
      Buffer.from('"}'),
    ]);
    writeFileSync(path, bytes);

    const error = await undo(e, real).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'not-utf8' });
    expect([...readFileSync(path)]).toEqual([...bytes]);
    expect(readManifest(e.env).files[real]).toHaveLength(1);
  });

  it('is left byte for byte as it is, for a file of lines with a block in it', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), 'node_modules/\n');
    const plan = e.planBlock('.cursorignore');
    await applyPlan(plan, e.env);
    const bytes = Buffer.concat([Buffer.from(plan.after), NOT_UTF8, Buffer.from('\n')]);
    writeFileSync(e.file('.cursorignore'), bytes);

    const error = await undo(e, plan.real).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: 'not-utf8' });
    expect([...readFileSync(e.file('.cursorignore'))]).toEqual([...bytes]);
    expect(readManifest(e.env).files[plan.real]).toHaveLength(1);
    expect(readdirSync(e.project).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('says which file, and quotes none of it', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    writeFileSync(path, Buffer.concat([Buffer.from('secret-looking-text '), NOT_UTF8]));

    const error = (await undo(e, real).catch((err: unknown) => err)) as Error;

    expect(error.message).toContain(real);
    expect(error.message).not.toContain('secret-looking');
  });
});

describe('undoFile: the files are too large to show a diff of', () => {
  it('goes ahead without the diff, and says that it left it out', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    owner(path, (doc) => ({ ...doc, big: 'x'.repeat(600 * 1024) }));

    const result = await undo(e, real);

    expect(result.status).toBe('surgical');
    expect(result.diff).toBe('');
    expect(result.notices).toContain(DIFF_OMITTED_NOTICE);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(doc['permissions']).toBeUndefined();
    expect(doc['big']).toHaveLength(600 * 1024);
    expect(readManifest(e.env).files).toEqual({});
  });

  it('does not mistake any other failure of the preview for that one', async () => {
    const e = engine();
    const { real } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [addDeny('a')]);

    const result = await undo(e, real);

    expect(result.notices).not.toContain(DIFF_OMITTED_NOTICE);
  });
});

describe('undoFile: a record of a change that never happened', () => {
  it('is read as nothing to take out, and nothing is said about a value Stroq never set', async () => {
    const e = engine();
    const before = jsonText({ sandbox: { enabled: false } });
    writeFileSync(e.file('settings.json'), before);
    const plan = e.planJson('settings.json', [setSandbox(true)]);
    let renames = 0;
    // The copy and the record go in; the file does not, and the record cannot be taken back.
    const fs: Fs = {
      ...nodeFs,
      rename: (from, to) =>
        (renames += 1) <= 2 ? nodeFs.rename(from, to) : Promise.reject(new Error('simulated')),
      unlink: () => Promise.reject(new Error('simulated')),
    };
    await expect(applyPlan(plan, { ...e.env, fs })).rejects.toThrow(/simulated/);
    expect(readManifest(e.env).files[plan.real]).toHaveLength(1);

    const result = await undo(e, plan.real);

    expect(result.status).toBe('already-undone');
    expect(result.kept).toEqual([]);
    expect(result.diff).toBe('');
    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(before);
    expect(readManifest(e.env).files).toEqual({});
  });
});
