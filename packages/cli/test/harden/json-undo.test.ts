import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { planJsonEdits, undoJsonEdits } from '../../src/harden/json-edit.js';
import type { JsonEdit, JsonPlan, RecordedJsonEdit } from '../../src/harden/types.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const text = (value: unknown, indent: string | number = 2, finalNewline = true): string =>
  `${JSON.stringify(value, null, indent)}${finalNewline ? '\n' : ''}`;

function plan(contents: string | null, edits: readonly JsonEdit[]): JsonPlan {
  const file = join(tempDir(), 'settings.json');
  return planJsonEdits(file, edits, { read: () => contents });
}

const add = (path: string[], value: JsonEdit['value']): JsonEdit => ({
  kind: 'json-array-add',
  path,
  value,
});
const set = (path: string[], value: JsonEdit['value']): JsonEdit => ({
  kind: 'json-set',
  path,
  value,
});

/** What undo made of `current`, which must have been edited (not blocked). */
function undone(current: string, edits: readonly RecordedJsonEdit[]) {
  const result = undoJsonEdits(current, edits);
  if (result.outcome !== 'edited') throw new Error(`blocked: ${result.detail}`);
  return result;
}

/** Applies `edits` to `before`, then lets the owner change the document, then undoes. */
function undoAfter(
  before: string | null,
  edits: readonly JsonEdit[],
  owner: (doc: Record<string, unknown>) => Record<string, unknown> = (doc) => doc,
) {
  const made = plan(before, edits);
  const edited = text(owner(JSON.parse(made.after) as Record<string, unknown>));
  return { made, result: undone(edited, made.edits) };
}

describe('undoJsonEdits: nothing changed since', () => {
  it.each([
    [
      'an element added to an array that was there',
      text({ permissions: { deny: ['a'] } }),
      [add(['permissions', 'deny'], 'b')],
    ],
    [
      'an array made inside objects that were there',
      text({ permissions: { allow: ['a'] }, model: 'm' }),
      [add(['permissions', 'deny'], 'b')],
    ],
    ['a whole path made in an object', text({ model: 'm' }), [add(['permissions', 'deny'], 'b')]],
    [
      'a key set that was not there',
      text({ sandbox: { x: 1 } }),
      [set(['sandbox', 'enabled'], true)],
    ],
    [
      'a value replaced',
      text({ sandbox: { enabled: false } }),
      [set(['sandbox', 'enabled'], true)],
    ],
    [
      'two sets under a path that was made',
      text({ model: 'm' }),
      [
        set(['sandbox', 'enabled'], true),
        set(['sandbox', 'credentials', 'files'], [{ path: 'p' }]),
      ],
    ],
    [
      'edits of both kinds, in a file with 4 spaces',
      text({ a: 1, permissions: { deny: ['x'] } }, 4),
      [add(['permissions', 'deny'], 'y'), set(['sandbox', 'enabled'], true), add(['hooks'], 1)],
    ],
    [
      'a tab-indented file',
      text({ permissions: { deny: [] } }, '\t'),
      [add(['permissions', 'deny'], 'y')],
    ],
    ['a file with no newline at the end', text({ a: 1 }, 2, false), [add(['list'], 'z')]],
    ['a file with CRLF line endings', text({ a: 1 }).replace(/\n/g, '\r\n'), [add(['list'], 'z')]],
  ])('gives back the same bytes after %s', (_name, before, edits) => {
    const made = plan(before, edits);

    const result = undone(made.after, made.edits);

    expect(result.text).toBe(before);
    expect(result.kept).toEqual([]);
    expect(result.reformatted).toBe(false);
  });

  it('says the document is empty once everything Stroq made is gone, for a file Stroq made', () => {
    const made = plan(null, [add(['permissions', 'deny'], 'x'), set(['sandbox', 'enabled'], true)]);

    const result = undone(made.after, made.edits);

    expect(JSON.parse(result.text)).toEqual({});
    expect(result.empty).toBe(true);
  });

  it('does not call a document empty when the owner’s keys are still in it', () => {
    const made = plan(text({ model: 'm' }), [add(['permissions', 'deny'], 'x')]);

    expect(undone(made.after, made.edits).empty).toBe(false);
  });
});

describe('undoJsonEdits: the owner changed the file since', () => {
  it('takes out what Stroq added and keeps a key and an element the owner added', () => {
    const { result } = undoAfter(
      text({ permissions: { deny: ['mine'] } }),
      [add(['permissions', 'deny'], 'ours')],
      (doc) => {
        const permissions = doc['permissions'] as { deny: string[] };
        return {
          ...doc,
          model: 'their-model',
          permissions: { ...permissions, deny: [...permissions.deny, 'theirs-too'] },
        };
      },
    );

    expect(JSON.parse(result.text)).toEqual({
      permissions: { deny: ['mine', 'theirs-too'] },
      model: 'their-model',
    });
  });

  it('keeps the array and the objects Stroq made when the owner has put something in them', () => {
    const { result } = undoAfter(null, [add(['permissions', 'deny'], 'ours')], (doc) => {
      const permissions = doc['permissions'] as { deny: string[] };
      return { permissions: { ...permissions, deny: [...permissions.deny, 'theirs'] } };
    });

    expect(JSON.parse(result.text)).toEqual({ permissions: { deny: ['theirs'] } });
  });

  it('keeps an object Stroq made when the owner has put a sibling in it, and takes the rest', () => {
    const { result } = undoAfter(null, [add(['permissions', 'deny'], 'ours')], (doc) => ({
      permissions: { ...(doc['permissions'] as object), allow: ['mine'] },
    }));

    expect(JSON.parse(result.text)).toEqual({ permissions: { allow: ['mine'] } });
  });

  it('never removes an element that was there before Stroq came', () => {
    const before = text({ permissions: { deny: ['Read(~/.ssh/**)'] } });
    const made = plan(before, [add(['permissions', 'deny'], 'Read(~/.ssh/**)')]);
    expect(made.edits[0]).toMatchObject({ preexisting: true });

    const result = undone(made.after, made.edits);

    expect(result.text).toBe(before);
  });

  it('removes the element Stroq appended, and not an equal one that came before it', () => {
    const made = plan(text({ list: ['a'] }), [add(['list'], 'b')]);
    const current = text({ list: ['b', 'a', 'b', 'c'] });

    const result = undone(current, made.edits);

    expect(JSON.parse(result.text)).toEqual({ list: ['b', 'a', 'c'] });
  });

  it('leaves alone an element the owner has since changed, which is no longer Stroq’s', () => {
    const made = plan(text({ list: [] }), [add(['list'], 'ours')]);

    const result = undone(text({ list: ['ours, edited'] }), made.edits);

    expect(JSON.parse(result.text)).toEqual({ list: ['ours, edited'] });
  });

  describe('a value Stroq set', () => {
    it('is put back to what it was', () => {
      const made = plan(text({ sandbox: { enabled: false, other: 1 } }), [
        set(['sandbox', 'enabled'], true),
      ]);

      const result = undone(made.after, made.edits);

      expect(JSON.parse(result.text)).toEqual({ sandbox: { enabled: false, other: 1 } });
    });

    it('is removed when it was not there, and the object made for it goes too', () => {
      const made = plan(text({ model: 'm' }), [set(['sandbox', 'enabled'], true)]);

      const result = undone(made.after, made.edits);

      expect(JSON.parse(result.text)).toEqual({ model: 'm' });
    });

    it('is left as the owner has it when the owner changed it, and says so', () => {
      const made = plan(text({ sandbox: { enabled: false } }), [set(['sandbox', 'enabled'], true)]);
      const current = text({ sandbox: { enabled: 'sometimes' } });

      const result = undone(current, made.edits);

      expect(result.text).toBe(current);
      expect(result.kept).toEqual([
        'sandbox.enabled: it is not the value Stroq set any more, so it was left as it is',
      ]);
    });

    it('is left alone when the owner removed it already', () => {
      const made = plan(text({ sandbox: { enabled: false } }), [set(['sandbox', 'enabled'], true)]);
      const current = text({ sandbox: {} });

      const result = undone(current, made.edits);

      expect(result.text).toBe(current);
      expect(result.kept).toEqual([]);
    });

    it('does not name a value in what it says was kept', () => {
      const made = plan(text({}), [set(['token'], 'stroq_attack_fixture_value_0123456789')]);

      const result = undone(text({ token: 'something else' }), made.edits);

      expect(result.kept.join(' ')).not.toContain('stroq_attack_');
      expect(result.kept.join(' ')).not.toContain('something else');
    });
  });

  it('undoes the edits newest first, so that a shell shared by two of them is taken apart whole', () => {
    const made = plan(text({}), [
      set(['sandbox', 'enabled'], true),
      set(['sandbox', 'credentials', 'files'], []),
    ]);

    expect(undone(made.after, made.edits).text).toBe(text({}));
  });

  it('copes with a path that no longer leads anywhere', () => {
    const made = plan(text({ permissions: { deny: [] } }), [add(['permissions', 'deny'], 'x')]);

    for (const current of [
      text({ permissions: 'all' }),
      text({ permissions: { deny: 'x' } }),
      '{}\n',
    ]) {
      const result = undone(current, made.edits);
      expect(result.text).toBe(current);
    }
  });

  it('works on a key called __proto__ as on any other', () => {
    const made = plan(text({}), [set(['__proto__', 'x'], 1)]);

    const result = undone(made.after, made.edits);

    expect(result.text).toBe(text({}));
    expect(result.empty).toBe(true);
  });
});

describe('undoJsonEdits: the layout it leaves', () => {
  it('follows the file as it is now, not as it was', () => {
    const made = plan(text({ permissions: { deny: ['a'] } }, 2), [
      add(['permissions', 'deny'], 'b'),
    ]);
    const reindented = text(JSON.parse(made.after), 4);

    const result = undone(reindented, made.edits);

    expect(result.text).toBe(text({ permissions: { deny: ['a'] } }, 4));
    expect(result.reformatted).toBe(false);
  });

  it('says so when the file cannot be written back as it is, because Stroq must lay it out again', () => {
    const made = plan(text({ permissions: { deny: ['a'] } }), [add(['permissions', 'deny'], 'b')]);
    const minified = JSON.stringify(JSON.parse(made.after));

    const result = undone(minified, made.edits);

    expect(JSON.parse(result.text)).toEqual({ permissions: { deny: ['a'] } });
    expect(result.reformatted).toBe(true);
  });

  it('returns the text untouched, whatever its layout, when there is nothing to take out', () => {
    const made = plan(text({ list: [] }), [add(['list'], 'x')]);
    const current = '{"list":[]}';

    const result = undone(current, made.edits);

    expect(result.text).toBe(current);
    expect(result.reformatted).toBe(false);
  });

  it('is the same when it is run again', () => {
    const made = plan(text({ model: 'm' }), [add(['permissions', 'deny'], 'x')]);

    const once = undone(made.after, made.edits);
    const twice = undone(once.text, made.edits);

    expect(twice.text).toBe(once.text);
    expect(twice.kept).toEqual([]);
  });
});

describe('undoJsonEdits: a file it cannot edit safely', () => {
  const made = plan(text({ model: 'm' }), [add(['permissions', 'deny'], 'x')]);

  it('does not touch a file that has since got a comment, and says why', () => {
    const current = '{\n  // my note\n  "permissions": {"deny": ["x"]}\n}\n';

    const result = undoJsonEdits(current, made.edits);

    expect(result.outcome).toBe('blocked');
    expect(result).toMatchObject({ refused: 'jsonc' });
  });

  it('does not touch a file that is no longer JSON, or no longer an object', () => {
    expect(undoJsonEdits('{"a": ', made.edits)).toMatchObject({
      outcome: 'blocked',
      refused: 'invalid-json',
    });
    expect(undoJsonEdits('[1]\n', made.edits)).toMatchObject({
      outcome: 'blocked',
      refused: 'not-object',
    });
  });
});
