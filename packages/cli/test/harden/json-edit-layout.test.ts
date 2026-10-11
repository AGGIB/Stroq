import { afterEach, describe, expect, it } from 'vitest';
import { removeTempDirs } from './helpers.js';
import { addDeny, plan, text } from './json-edit-fixtures.js';

afterEach(removeTempDirs);

/**
 * Whether `planJsonEdits` keeps the layout the owner's file has (the indent, the line breaks, the
 * byte order mark), and whether a file survives being written back at all.
 */

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

  // A duplicated key, a number a double cannot hold and keys that an object would reorder are not
  // a change of layout but a loss of what the file says: they are refused (see json-lossy.test.ts).
  it.each([
    ['a minified file', '{"permissions":{"deny":["a"]}}\n'],
    ['a number written 1.0', '{\n  "n": 1.0\n}\n'],
    ['an escaped letter', '{\n  "a": "\\u00e9"\n}\n'],
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
