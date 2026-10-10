import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/harden/diff.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import type { JsonEdit } from '../../src/harden/types.js';
import { removeTempDirs } from './helpers.js';
import { addDeny, plan, text } from './json-edit-fixtures.js';

afterEach(removeTempDirs);

describe('planJsonEdits: adding to an array', () => {
  it('appends to an array that is there, and shows the change', () => {
    const before = text({ permissions: { deny: ['Read(./.env)'] } });

    const result = plan(before, [addDeny('Read(~/.ssh/**)')]);

    expect(result.after).toBe(text({ permissions: { deny: ['Read(./.env)', 'Read(~/.ssh/**)'] } }));
    expect(result.before).toBe(before);
    expect(result.changed).toBe(true);
    expect(result.refused).toBeUndefined();
    expect(result.existed).toBe(true);
    expect(result.diff).toBe(unifiedDiff(before, result.after, { path: result.file }));
    expect(result.diff).toContain('+      "Read(~/.ssh/**)"');
    expect(result.edits).toEqual([
      {
        kind: 'json-array-add',
        path: ['permissions', 'deny'],
        value: 'Read(~/.ssh/**)',
        preexisting: false,
        createdFrom: 2,
      },
    ]);
  });

  it('appends after what the owner already has, in the owner order, touching nothing else', () => {
    const before = text({ b: 1, permissions: { allow: ['x'], deny: ['y'] }, a: [3, 2, 1] });

    const result = plan(before, [addDeny('z')]);

    expect(JSON.parse(result.after)).toEqual({
      b: 1,
      permissions: { allow: ['x'], deny: ['y', 'z'] },
      a: [3, 2, 1],
    });
    expect(Object.keys(JSON.parse(result.after) as object)).toEqual(['b', 'permissions', 'a']);
  });

  it('makes the objects and the array on the way when they are not there', () => {
    const result = plan(text({ model: 'x' }), [addDeny('Read(./.env)')]);

    expect(JSON.parse(result.after)).toEqual({
      model: 'x',
      permissions: { deny: ['Read(./.env)'] },
    });
    expect(result.edits[0]).toMatchObject({ preexisting: false, createdFrom: 0 });
  });

  it('records where it started making things, so undo can take the empty shell away too', () => {
    const result = plan(text({ permissions: {} }), [addDeny('Read(./.env)')]);

    expect(result.edits[0]).toMatchObject({ createdFrom: 1 });
  });

  it('makes the file when there is none, and says the old side of the diff is nothing', () => {
    const result = plan(null, [addDeny('Read(./.env)')]);

    expect(result.existed).toBe(false);
    expect(result.before).toBe('');
    expect(result.after).toBe(text({ permissions: { deny: ['Read(./.env)'] } }));
    expect(result.diff.split('\n')[0]).toBe('--- /dev/null');
    expect(result.backup).toBe('none-new-file');
    expect(result.changed).toBe(true);
  });

  it('treats a file with nothing in it but white space as an empty object', () => {
    const result = plan('  \n\n', [addDeny('Read(./.env)')]);

    expect(result.existed).toBe(true);
    expect(JSON.parse(result.after)).toEqual({ permissions: { deny: ['Read(./.env)'] } });
    expect(result.roundTrips).toBe(true);
  });

  describe('an element that is already there', () => {
    it('is recorded as the owner’s and changes nothing, not a byte', () => {
      const before = text({ permissions: { deny: ['Read(~/.ssh/**)', 'other'] } });

      const result = plan(before, [addDeny('Read(~/.ssh/**)')]);

      expect(result.after).toBe(before);
      expect(result.changed).toBe(false);
      expect(result.diff).toBe('');
      expect(result.edits).toEqual([
        {
          kind: 'json-array-add',
          path: ['permissions', 'deny'],
          value: 'Read(~/.ssh/**)',
          preexisting: true,
          createdFrom: 2,
        },
      ]);
    });

    it('is found whatever the order of the keys of an object element', () => {
      const before = text({ list: [{ b: 1, a: [1, 2] }] });

      const result = plan(before, [
        { kind: 'json-array-add', path: ['list'], value: { a: [1, 2], b: 1 } },
      ]);

      expect(result.edits[0]).toMatchObject({ preexisting: true });
      expect(result.after).toBe(before);
    });

    it('is not found when only the order of an inner array differs', () => {
      const result = plan(text({ list: [[1, 2]] }), [
        { kind: 'json-array-add', path: ['list'], value: [2, 1] },
      ]);

      expect(result.edits[0]).toMatchObject({ preexisting: false });
      expect(JSON.parse(result.after)).toEqual({
        list: [
          [1, 2],
          [2, 1],
        ],
      });
    });

    it('is not found when only the type differs: "1" is not 1', () => {
      const result = plan(text({ list: [1, null] }), [
        { kind: 'json-array-add', path: ['list'], value: '1' },
        { kind: 'json-array-add', path: ['list'], value: false },
      ]);

      expect(
        result.edits.map((edit) => edit.kind === 'json-array-add' && edit.preexisting),
      ).toEqual([false, false]);
    });

    it('is only added once when a plan asks for the same value twice', () => {
      const result = plan(text({ list: [] }), [
        { kind: 'json-array-add', path: ['list'], value: 'x' },
        { kind: 'json-array-add', path: ['list'], value: 'x' },
      ]);

      expect(JSON.parse(result.after)).toEqual({ list: ['x'] });
      expect(
        result.edits.map((edit) => edit.kind === 'json-array-add' && edit.preexisting),
      ).toEqual([false, true]);
    });

    it('lets a plan add what is missing while it leaves what is there', () => {
      const before = text({ permissions: { deny: ['a'] } });

      const result = plan(before, [addDeny('a'), addDeny('b')]);

      expect(JSON.parse(result.after)).toEqual({ permissions: { deny: ['a', 'b'] } });
      expect(
        result.edits.map((edit) => edit.kind === 'json-array-add' && edit.preexisting),
      ).toEqual([true, false]);
    });
  });

  it('adds objects and nested arrays as elements', () => {
    const value = { type: 'command', command: 'stroq hook claude-code', list: [1, [2], null] };

    const result = plan(text({ hooks: [] }), [{ kind: 'json-array-add', path: ['hooks'], value }]);

    expect(JSON.parse(result.after)).toEqual({ hooks: [value] });
  });
});

describe('planJsonEdits: setting a value', () => {
  const set = (path: string[], value: JsonEdit['value']): JsonEdit => ({
    kind: 'json-set',
    path,
    value,
  });

  it('sets a key that is not there, and records that it was not', () => {
    const before = text({ sandbox: { network: {} } });

    const result = plan(before, [set(['sandbox', 'enabled'], true)]);

    expect(JSON.parse(result.after)).toEqual({ sandbox: { network: {}, enabled: true } });
    expect(result.edits).toEqual([
      {
        kind: 'json-set',
        path: ['sandbox', 'enabled'],
        value: true,
        previous: { present: false },
        createdFrom: 1,
      },
    ]);
  });

  it('replaces a value and records the one it replaced', () => {
    const result = plan(text({ sandbox: { enabled: false } }), [set(['sandbox', 'enabled'], true)]);

    expect(JSON.parse(result.after)).toEqual({ sandbox: { enabled: true } });
    expect(result.edits[0]).toMatchObject({
      previous: { present: true, value: false },
      createdFrom: 2,
    });
  });

  it('records a replaced object whole', () => {
    const old = { files: [{ path: 'a', mode: 'deny' }] };

    const result = plan(text({ sandbox: { credentials: old } }), [
      set(['sandbox', 'credentials'], { files: [] }),
    ]);

    expect(result.edits[0]).toMatchObject({ previous: { present: true, value: old } });
  });

  it('changes nothing when the value is already what is asked', () => {
    const before = text({ sandbox: { enabled: true } });

    const result = plan(before, [set(['sandbox', 'enabled'], true)]);

    expect(result.after).toBe(before);
    expect(result.changed).toBe(false);
    expect(result.edits[0]).toMatchObject({ previous: { present: true, value: true } });
  });

  it('makes the objects on the way, and says from where', () => {
    const result = plan(text({}), [set(['sandbox', 'credentials', 'files'], [])]);

    expect(JSON.parse(result.after)).toEqual({ sandbox: { credentials: { files: [] } } });
    expect(result.edits[0]).toMatchObject({ previous: { present: false }, createdFrom: 0 });
  });

  it('works on what an earlier edit of the same plan made', () => {
    const result = plan(text({}), [
      set(['sandbox', 'enabled'], true),
      set(['sandbox', 'credentials', 'files'], []),
    ]);

    expect(JSON.parse(result.after)).toEqual({
      sandbox: { enabled: true, credentials: { files: [] } },
    });
    expect(result.edits.map((edit) => edit.createdFrom)).toEqual([0, 1]);
  });

  it('replaces a value of one type with a value of another', () => {
    const result = plan(text({ a: 'text' }), [set(['a'], { b: [1] })]);

    expect(JSON.parse(result.after)).toEqual({ a: { b: [1] } });
  });
});

describe('planJsonEdits: the plan', () => {
  it('names the byte backup it will keep, or says there will be none', () => {
    expect(plan(text({ a: 1 }), [addDeny('x')]).backup).toBe('copy');
    const holding = plan(text({ env: { API_TOKEN: 'stroq_attack_fixture_value_0123456789' } }), [
      addDeny('x'),
    ]);
    expect(holding.backup).toBe('none-credential-text');
    // The credential's line is context in the diff, so the diff hides it and says so.
    expect(holding.notices).toEqual([
      'no byte backup: the file holds credential-shaped text',
      'the diff hides lines that hold credential-shaped text',
    ]);
  });

  it('carries the recipe, the root and the mode for a new file that it was given', () => {
    const result = plan(null, [addDeny('x')], {
      recipe: 'claude-deny-read',
      root: '/some/root',
      newFileMode: 0o644,
    });

    expect(result).toMatchObject({
      recipe: 'claude-deny-read',
      root: '/some/root',
      newFileMode: 0o644,
      kind: 'json',
    });
  });

  it('names a recipe even when it was not given one', () => {
    expect(plan(null, [addDeny('x')]).recipe).toBe('custom');
  });
});
