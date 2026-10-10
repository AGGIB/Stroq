import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBackup } from '../../src/harden/backup.js';
import { applyPlan } from '../../src/harden/index.js';
import { readManifest } from '../../src/harden/manifest.js';
import { HardenError } from '../../src/harden/types.js';
import { FIXED_NOW, removeTempDirs, tempDir } from './helpers.js';
import { IGNORE_ID, addDeny, engine, jsonText, sha256 } from './engine-setup.js';

afterEach(removeTempDirs);

const onWindows = process.platform === 'win32';
const FAKE_SECRET = 'stroq_attack_fixture_value_0123456789';

describe('applyPlan: making the change', () => {
  it('writes the planned text, keeps a copy of what was there and records what it did', async () => {
    const { env, file, home, planJson } = engine();
    const before = jsonText({ permissions: { deny: ['a'] } });
    writeFileSync(file('settings.json'), before);
    const plan = planJson('settings.json', [addDeny('b')]);

    const result = await applyPlan(plan, env);

    expect(readFileSync(file('settings.json'), 'utf8')).toBe(plan.after);
    expect(result.changed).toBe(true);
    expect(result.real).toBe(file('settings.json'));
    expect(result.diff).toBe(plan.diff);
    expect(result.backup).toMatchObject({ stored: true });
    const entries = readManifest(env).files[file('settings.json')];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]).toEqual({
      recipe: 'test-recipe',
      created: false,
      edits: plan.edits,
      shaBefore: sha256(before),
      shaAfter: sha256(plan.after),
      backup: result.backup?.id,
      stroqVersion: '0.0.0-test',
      appliedAt: new Date(FIXED_NOW.getTime()).toISOString(),
    });
    expect(result.entry).toEqual(entries?.[0]);
    expect(readBackup(env, file('settings.json'), result.backup?.id ?? '')).toBe(before);
    expect(existsSync(join(home, 'backups'))).toBe(true);
  });

  it('records the time the clock said', async () => {
    const { env, file, planJson } = engine({ now: () => new Date('2027-01-02T03:04:05.678Z') });
    writeFileSync(file('settings.json'), '{}\n');

    const result = await applyPlan(planJson('settings.json', [addDeny('a')]), env);

    expect(result.entry?.appliedAt).toBe('2027-01-02T03:04:05.678Z');
  });

  it('makes a file that was not there, without a copy, and says it made it', async () => {
    const { env, file, home, planJson } = engine();
    const plan = planJson('.claude/settings.json', [addDeny('a')]);

    const result = await applyPlan(plan, env);

    expect(readFileSync(file('.claude/settings.json'), 'utf8')).toBe(plan.after);
    expect(result.backup).toBeNull();
    expect(result.entry).toMatchObject({ created: true, shaBefore: null, backup: null });
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('writes a block to a line-oriented file, and records it', async () => {
    const { env, file, planBlock } = engine();
    writeFileSync(file('.cursorignore'), 'node_modules/\n');
    const plan = planBlock('.cursorignore');

    const result = await applyPlan(plan, env);

    expect(readFileSync(file('.cursorignore'), 'utf8')).toBe(plan.after);
    expect(result.entry?.edits).toEqual(plan.edits);
    expect(result.entry?.edits[0]).toMatchObject({ kind: 'text-block', id: IGNORE_ID });
  });

  describe.skipIf(onWindows)('file modes', () => {
    it('keeps the mode of a file it replaces', async () => {
      const { env, file, planJson } = engine();
      writeFileSync(file('settings.json'), '{}\n');
      chmodSync(file('settings.json'), 0o640);

      await applyPlan(planJson('settings.json', [addDeny('a')]), env);

      expect(statSync(file('settings.json')).mode & 0o777).toBe(0o640);
    });

    it('makes a new file private, or with the mode the plan was given', async () => {
      const { env, file, planJson } = engine();

      await applyPlan(planJson('private.json', [addDeny('a')]), env);
      await applyPlan(planJson('shared.json', [addDeny('a')], { newFileMode: 0o644 }), env);

      expect(statSync(file('private.json')).mode & 0o777).toBe(0o600);
      expect(statSync(file('shared.json')).mode & 0o777).toBe(0o644);
    });

    it('replaces the real file of a symlinked dotfile and leaves the link a link', async () => {
      const { env, file, project, planJson } = engine();
      const real = join(project, 'dotfiles', 'settings.json');
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, '{}\n');
      symlinkSync(real, file('settings.json'));
      const plan = planJson('settings.json', [addDeny('a')]);

      const result = await applyPlan(plan, env);

      expect(readFileSync(real, 'utf8')).toBe(plan.after);
      expect(statSync(file('settings.json')).isFile()).toBe(true);
      expect(result.real).toBe(real);
      expect(Object.keys(readManifest(env).files)).toEqual([real]);
    });
  });

  it('keeps no copy of a file that holds a credential, and says so', async () => {
    const { env, file, home, planJson } = engine();
    writeFileSync(file('settings.json'), jsonText({ env: { API_TOKEN: FAKE_SECRET } }));
    const plan = planJson('settings.json', [addDeny('a')]);
    expect(plan.backup).toBe('none-credential-text');

    const result = await applyPlan(plan, env);

    expect(result.backup).toEqual({
      id: expect.any(String),
      stored: false,
      reason: 'the file holds credential-shaped text',
    });
    expect(result.entry?.backup).toBeNull();
    expect(JSON.parse(readFileSync(file('settings.json'), 'utf8'))).toMatchObject({
      permissions: { deny: ['a'] },
    });
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('does nothing at all when the plan changes nothing', async () => {
    const { env, file, home, planJson } = engine();
    writeFileSync(file('settings.json'), jsonText({ permissions: { deny: ['a'] } }));
    const mtime = statSync(file('settings.json')).mtimeMs;
    const plan = planJson('settings.json', [addDeny('a')]);
    expect(plan.changed).toBe(false);

    const result = await applyPlan(plan, env);

    expect(result).toEqual({
      changed: false,
      real: file('settings.json'),
      diff: '',
      backup: null,
      entry: null,
    });
    expect(statSync(file('settings.json')).mtimeMs).toBe(mtime);
    expect(existsSync(join(home, 'harden'))).toBe(false);
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('records a second apply after the first, newest last', async () => {
    const { env, file, planJson } = engine();
    writeFileSync(file('settings.json'), '{}\n');

    await applyPlan(planJson('settings.json', [addDeny('a')]), env);
    await applyPlan(planJson('settings.json', [addDeny('b')]), env);

    const entries = readManifest(env).files[file('settings.json')] ?? [];
    expect(
      entries.map((entry) =>
        entry.edits.map((edit) => edit.kind === 'json-array-add' && edit.value),
      ),
    ).toEqual([['a'], ['b']]);
    expect(entries.map((entry) => entry.backup)).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.backup)).size).toBe(2);
  });
});

describe('applyPlan: a plan it will not apply', () => {
  it('refuses a plan that was refused, and touches nothing', async () => {
    const { env, file, home, planJson } = engine();
    const before = '{\n  // my note\n  "a": 1\n}\n';
    writeFileSync(file('settings.json'), before);
    const plan = planJson('settings.json', [addDeny('a')]);
    expect(plan.refused).toBe('jsonc');

    const error = await applyPlan(plan, env).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'plan-refused' });
    expect(readFileSync(file('settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, 'harden'))).toBe(false);
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  describe('because the file is not what it was made from', () => {
    it('refuses when the owner has edited the file since, and keeps their edit', async () => {
      const { env, file, home, planJson } = engine();
      writeFileSync(file('settings.json'), jsonText({ a: 1 }));
      const plan = planJson('settings.json', [addDeny('x')]);
      const theirs = jsonText({ a: 1, theirs: true });
      writeFileSync(file('settings.json'), theirs);

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'stale-plan' });

      expect(readFileSync(file('settings.json'), 'utf8')).toBe(theirs);
      expect(existsSync(join(home, 'harden'))).toBe(false);
      expect(existsSync(join(home, 'backups'))).toBe(false);
    });

    it('refuses when a file that was not there has appeared', async () => {
      const { env, file, planJson } = engine();
      const plan = planJson('settings.json', [addDeny('x')]);
      writeFileSync(file('settings.json'), '{"theirs": true}\n');

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'stale-plan' });

      expect(readFileSync(file('settings.json'), 'utf8')).toBe('{"theirs": true}\n');
    });

    it('refuses when the file that was there has gone', async () => {
      const { env, file, planJson } = engine();
      writeFileSync(file('settings.json'), '{}\n');
      const plan = planJson('settings.json', [addDeny('x')]);
      unlinkSync(file('settings.json'));

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'stale-plan' });

      expect(existsSync(file('settings.json'))).toBe(false);
    });

    it('refuses a plan that has been applied already', async () => {
      const { env, file, planJson } = engine();
      writeFileSync(file('settings.json'), '{}\n');
      const plan = planJson('settings.json', [addDeny('x')]);
      await applyPlan(plan, env);

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'stale-plan' });

      expect(readManifest(env).files[file('settings.json')]).toHaveLength(1);
    });

    it.skipIf(onWindows)('refuses when the path now leads to another file', async () => {
      const { env, file, project, planJson } = engine();
      const first = join(project, 'first.json');
      const second = join(project, 'second.json');
      writeFileSync(first, '{}\n');
      writeFileSync(second, '{}\n');
      symlinkSync(first, file('settings.json'));
      const plan = planJson('settings.json', [addDeny('x')]);
      unlinkSync(file('settings.json'));
      symlinkSync(second, file('settings.json'));

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'stale-plan' });

      expect(readFileSync(first, 'utf8')).toBe('{}\n');
      expect(readFileSync(second, 'utf8')).toBe('{}\n');
    });
  });

  describe.skipIf(onWindows)('because of where the path leads', () => {
    // The plan is made while the file is an ordinary one; the link is put there afterwards, which
    // is what a plan that has waited for a person to say yes can meet.
    it('refuses a link out of the root before it keeps a copy or records anything', async () => {
      const { env, file, home, project, planJson } = engine();
      const victim = join(tempDir('outside'), 'victim.json');
      writeFileSync(victim, '{}\n');
      writeFileSync(file('settings.json'), '{}\n');
      const plan = planJson('settings.json', [addDeny('x')], { root: project });
      unlinkSync(file('settings.json'));
      symlinkSync(victim, file('settings.json'));

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'path-escapes-root' });

      expect(readFileSync(victim, 'utf8')).toBe('{}\n');
      expect(existsSync(join(home, 'harden'))).toBe(false);
      expect(existsSync(join(home, 'backups'))).toBe(false);
    });

    // A plan made from a link that already leaves the root is a refused plan: the planner did not
    // even read it.
    it('refuses a plan that was made from a link out of the root, as a plan that was refused', async () => {
      const { env, file, home, project, planJson } = engine();
      const victim = join(tempDir('outside'), 'victim.json');
      writeFileSync(victim, '{}\n');
      symlinkSync(victim, file('settings.json'));
      const plan = planJson('settings.json', [addDeny('x')], { root: project });
      expect(plan.refused).toBe('path-escapes-root');

      await expect(applyPlan(plan, env)).rejects.toMatchObject({ code: 'plan-refused' });

      expect(readFileSync(victim, 'utf8')).toBe('{}\n');
      expect(existsSync(join(home, 'harden'))).toBe(false);
      expect(existsSync(join(home, 'backups'))).toBe(false);
    });
  });
});
