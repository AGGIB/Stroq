import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/harden/diff.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import type { JsonEdit, JsonPlan, PlanOptions } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/** A JSON document as an editor would save it. */
const text = (value: unknown, indent: string | number = 2, finalNewline = true): string =>
  `${JSON.stringify(value, null, indent)}${finalNewline ? '\n' : ''}`;

/** Plans `edits` against a file holding `contents` (`null`: there is no such file). */
function plan(
  contents: string | null,
  edits: readonly JsonEdit[],
  extra: Partial<PlanOptions> = {},
): JsonPlan {
  const file = join(tempDir(), 'settings.json');
  return planJsonEdits(file, edits, { read: () => contents, ...extra });
}

const addDeny = (value: string): JsonEdit => ({
  kind: 'json-array-add',
  path: ['permissions', 'deny'],
  value,
});

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

describe('planJsonEdits: the layout of the file', () => {
  const edit = addDeny('x');
  const doc = { permissions: { deny: ['a'] } };

  it.each([
    ['2 spaces', 2],
    ['4 spaces', 4],
    ['a tab', '\t'],
    ['3 spaces', 3],
  ])('keeps an indent of %s', (_name, indent) => {
    const before = text(doc, indent);

    const result = plan(before, [edit]);

    expect(result.after).toBe(text({ permissions: { deny: ['a', 'x'] } }, indent));
    expect(result.roundTrips).toBe(true);
    expect(result.formatting).toBe('preserved');
  });

  it('uses 2 spaces when the file has nothing indented to learn from', () => {
    const result = plan('{}\n', [edit]);

    expect(result.after).toBe(text({ permissions: { deny: ['x'] } }, 2));
  });

  it('keeps the newline at the end of the file, and the lack of one', () => {
    expect(plan(text(doc, 2, true), [edit]).after.endsWith('}\n')).toBe(true);
    const bare = plan(text(doc, 2, false), [edit]).after;
    expect(bare.endsWith('}')).toBe(true);
    expect(bare.endsWith('\n')).toBe(false);
  });

  it('keeps CRLF line endings', () => {
    const before = text(doc).replace(/\n/g, '\r\n');

    const result = plan(before, [edit]);

    expect(result.after).toBe(text({ permissions: { deny: ['a', 'x'] } }).replace(/\n/g, '\r\n'));
    expect(result.roundTrips).toBe(true);
  });

  it('keeps a byte order mark', () => {
    const before = `\uFEFF${text(doc)}`;

    const result = plan(before, [edit]);

    expect(result.after).toBe(`\uFEFF${text({ permissions: { deny: ['a', 'x'] } })}`);
    expect(result.roundTrips).toBe(true);
  });

  it('writes a new file with 2 spaces and a newline at the end', () => {
    expect(plan(null, [edit]).after).toBe(text({ permissions: { deny: ['x'] } }));
  });
});

describe('planJsonEdits: whether the file survives being written back', () => {
  const edit = addDeny('x');

  it('says the layout is kept for a file that parses and prints as itself', () => {
    const result = plan(text({ permissions: { deny: [] } }), [edit]);

    expect(result.roundTrips).toBe(true);
    expect(result.formatting).toBe('preserved');
  });

  it.each([
    ['a minified file', '{"permissions":{"deny":["a"]}}\n'],
    ['a duplicated key', '{\n  "a": 1,\n  "a": 2\n}\n'],
    ['a number too large to keep', '{\n  "big": 12345678901234567890\n}\n'],
    ['a number written 1.0', '{\n  "n": 1.0\n}\n'],
    ['an escaped letter', '{\n  "a": "\\u00e9"\n}\n'],
    ['keys that look like numbers', '{\n  "b": 1,\n  "2": 2\n}\n'],
    ['two newlines at the end', '{\n  "a": 1\n}\n\n'],
    ['mixed indentation', '{\n  "a": {\n      "b": 1\n  }\n}\n'],
  ])('says the layout will change for %s', (_name, before) => {
    const result = plan(before, [edit]);

    expect(result.roundTrips).toBe(false);
    expect(result.formatting).toBe('will-change');
    expect(result.refused).toBeUndefined();
    expect(JSON.parse(result.after)).toMatchObject({
      permissions: { deny: expect.arrayContaining(['x']) },
    });
  });

  it('judges the file as it is, before the edit, not as it will be', () => {
    const result = plan(text({ a: 1 }), [edit]);

    expect(result.roundTrips).toBe(true);
    expect(result.changed).toBe(true);
  });

  // Nothing to change means nothing is rewritten, whatever shape the file is in.
  it('leaves a file that does not round-trip byte for byte when there is nothing to do', () => {
    const before = '{"permissions":{"deny":["x"]}}';

    const result = plan(before, [edit]);

    expect(result.roundTrips).toBe(false);
    expect(result.after).toBe(before);
    expect(result.changed).toBe(false);
  });
});

describe('planJsonEdits: the plan', () => {
  it('names the byte backup it will keep, or says there will be none', () => {
    expect(plan(text({ a: 1 }), [addDeny('x')]).backup).toBe('copy');
    const holding = plan(text({ env: { API_TOKEN: 'stroq_attack_fixture_value_0123456789' } }), [
      addDeny('x'),
    ]);
    expect(holding.backup).toBe('none-credential-text');
    expect(holding.notices).toEqual(['no byte backup: the file holds credential-shaped text']);
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
