import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/harden/diff.js';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import { addDeny, applied, engine, jsonText, owner, setSandbox, undo } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

afterEach(removeTempDirs);

const FAKE_SECRET = 'stroq_attack_fixture_value_0123456789';

describe('undoFile: nothing has changed since', () => {
  it('gives back the same bytes from the copy, and says what changed', async () => {
    const e = engine();
    const before = jsonText({ model: 'm', permissions: { deny: ['a'] } });
    const { plan, real, path } = await applied(e, 'settings.json', before, [addDeny('b')]);

    const result = await undo(e, real);

    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(result).toMatchObject({ status: 'restored', real, kept: [], applications: 1 });
    expect(result.diff).toBe(unifiedDiff(plan.after, before, { path: real }));
    expect(readManifest(e.env).files).toEqual({});
  });

  it('removes a file that Stroq made and nobody has touched since', async () => {
    const e = engine();
    const { plan, real, path } = await applied(e, '.claude/settings.json', null, [addDeny('a')]);

    const result = await undo(e, real);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(e.file('.claude'))).toBe(false);
    expect(result.status).toBe('restored');
    expect(result.diff).toBe(unifiedDiff(plan.after, '', { path: real, newMissing: true }));
    expect(result.diff).toContain('+++ /dev/null');
    expect(readManifest(e.env).files).toEqual({});
  });

  it('removes nested empty folders apply made, but leaves folders with other files', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'nested/sub/.claude/settings.json', null, [
      addDeny('a'),
    ]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(e.file('nested/sub/.claude'))).toBe(true);

    writeFileSync(e.file('nested/readme.txt'), 'hello');

    await undo(e, real);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(e.file('nested/sub/.claude'))).toBe(false);
    expect(existsSync(e.file('nested/sub'))).toBe(false);
    expect(existsSync(e.file('nested'))).toBe(true);
    expect(existsSync(e.file('nested/readme.txt'))).toBe(true);
  });

  it('takes a block out of a line-oriented file and gives back the same bytes', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), 'node_modules/');
    const plan = e.planBlock('.cursorignore');
    await applyPlan(plan, e.env);

    const result = await undo(e, plan.real);

    expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe('node_modules/');
    expect(result.status).toBe('restored');
  });

  it('removes a line-oriented file that Stroq made', async () => {
    const e = engine();
    const plan = e.planBlock('.cursorignore');
    await applyPlan(plan, e.env);

    const result = await undo(e, plan.real);

    expect(existsSync(e.file('.cursorignore'))).toBe(false);
    expect(result.status).toBe('restored');
  });

  it('gives back the same bytes after two applies, one copy at a time', async () => {
    const e = engine();
    const before = jsonText({ model: 'm' });
    writeFileSync(e.file('settings.json'), before);
    const first = e.planJson('settings.json', [addDeny('a')]);
    await applyPlan(first, e.env);
    await applyPlan(e.planJson('settings.json', [setSandbox(true)]), e.env);

    const result = await undo(e, first.real);

    expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(before);
    expect(result).toMatchObject({ status: 'restored', applications: 2 });
    expect(readManifest(e.env).files).toEqual({});
  });

  describe('when no copy was kept because the file held a credential', () => {
    it('takes its own entries out and gives back the same bytes', async () => {
      const e = engine();
      const before = jsonText({ env: { API_TOKEN: FAKE_SECRET }, model: 'm' });
      const {
        result: made,
        real,
        path,
      } = await applied(e, 'settings.json', before, [addDeny('a'), setSandbox(true)]);
      expect(made.backup?.stored).toBe(false);

      const result = await undo(e, real);

      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(result.status).toBe('surgical');
    });

    it('does the same for a line-oriented file', async () => {
      const e = engine();
      const before = `API_TOKEN=${FAKE_SECRET}\nnode_modules/\n`;
      writeFileSync(e.file('.cursorignore'), before);
      const plan = e.planBlock('.cursorignore');
      const made = await applyPlan(plan, e.env);
      expect(made.backup?.stored).toBe(false);

      const result = await undo(e, plan.real);

      expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe(before);
      expect(result.status).toBe('surgical');
    });
  });
});

describe('undoFile: the owner changed the file since', () => {
  it('takes out what Stroq added and keeps what the owner added', async () => {
    const e = engine();
    const { real, path } = await applied(
      e,
      'settings.json',
      jsonText({ permissions: { deny: ['mine'] } }),
      [addDeny('ours')],
    );
    owner(path, (doc) => {
      const permissions = doc['permissions'] as { deny: string[] };
      return { ...doc, theirs: true, permissions: { deny: [...permissions.deny, 'theirs-too'] } };
    });

    const result = await undo(e, real);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      theirs: true,
      permissions: { deny: ['mine', 'theirs-too'] },
    });
    expect(result.status).toBe('surgical');
    // Only Stroq's element is a changed line; the owner's lines are context at most.
    const changed = result.diff
      .split('\n')
      .filter((row) => /^[-+]/.test(row) && !/^(---|\+\+\+) /.test(row));
    expect(changed).toEqual(['-      "ours",']);
    expect(readManifest(e.env).files).toEqual({});
  });

  it('never removes an element that was there before Stroq came', async () => {
    const e = engine();
    const { plan, real, path } = await applied(
      e,
      'settings.json',
      jsonText({ permissions: { deny: ['a'] } }),
      [addDeny('a'), addDeny('b')],
    );
    expect(plan.edits.map((edit) => edit.kind === 'json-array-add' && edit.preexisting)).toEqual([
      true,
      false,
    ]);
    owner(path, (doc) => ({ ...doc, theirs: 1 }));

    await undo(e, real);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      permissions: { deny: ['a'] },
      theirs: 1,
    });
  });

  it('leaves a value the owner changed since Stroq set it, and says so', async () => {
    const e = engine();
    const { real, path } = await applied(
      e,
      'settings.json',
      jsonText({ sandbox: { enabled: false } }),
      [setSandbox(true)],
    );
    owner(path, () => ({ sandbox: { enabled: 'sometimes' } }));

    const result = await undo(e, real);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ sandbox: { enabled: 'sometimes' } });
    expect(result.kept).toEqual([
      'sandbox.enabled: it is not the value Stroq set any more, so it was left as it is',
    ]);
    expect(result.status).toBe('surgical');
    expect(readManifest(e.env).files).toEqual({});
  });

  it('keeps the lines the owner wrote around a block, and removes the block', async () => {
    const e = engine();
    writeFileSync(e.file('.cursorignore'), 'node_modules/\n');
    const plan = e.planBlock('.cursorignore');
    await applyPlan(plan, e.env);
    const current = readFileSync(e.file('.cursorignore'), 'utf8');
    writeFileSync(e.file('.cursorignore'), `first\n${current}last\n`);

    const result = await undo(e, plan.real);

    expect(readFileSync(e.file('.cursorignore'), 'utf8')).toBe('first\nnode_modules/\nlast\n');
    expect(result.status).toBe('surgical');
  });

  it('keeps a file that Stroq made once the owner has put their own settings in it', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', null, [addDeny('ours')]);
    owner(path, (doc) => ({ ...doc, model: 'theirs' }));

    await undo(e, real);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'theirs' });
  });

  it('removes a file that Stroq made when the owner has taken out everything Stroq put in it', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', null, [addDeny('ours')]);
    writeFileSync(path, '{}\n');

    const result = await undo(e, real);

    expect(existsSync(path)).toBe(false);
    expect(result.status).toBe('surgical');
  });

  it('takes the edits of two applies out when the owner changed the file between them', async () => {
    const e = engine();
    const { path, real } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    owner(path, (doc) => ({ ...doc, theirs: 1 }));
    await applyPlan(e.planJson('settings.json', [addDeny('b')]), e.env);

    const result = await undo(e, real);

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'm', theirs: 1 });
    expect(result).toMatchObject({ status: 'surgical', applications: 2 });
  });

  it('says so when the file has to be laid out again to take the entries out', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    writeFileSync(
      path,
      JSON.stringify({ ...(JSON.parse(readFileSync(path, 'utf8')) as object), theirs: 1 }),
    );

    const result = await undo(e, real);

    expect(result.reformatted).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ model: 'm', theirs: 1 });
  });

  it('does not bring back a file the owner deleted', async () => {
    const e = engine();
    const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'm' }), [
      addDeny('a'),
    ]);
    unlinkSync(path);

    const result = await undo(e, real);

    expect(existsSync(path)).toBe(false);
    expect(result).toMatchObject({ status: 'already-undone', diff: '' });
    expect(readManifest(e.env).files).toEqual({});
  });
});
