import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deepEqual, findJsoncSyntax, planJsonEdits } from '../../src/harden/json-edit.js';
import { HardenError, type JsonEdit, type JsonPlan } from '../../src/harden/types.js';
import { cpuNow } from '../helpers/cpu-time.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const addDeny = (value: string): JsonEdit => ({
  kind: 'json-array-add',
  path: ['permissions', 'deny'],
  value,
});

function plan(contents: string | null, edits: readonly JsonEdit[] = [addDeny('x')]): JsonPlan {
  const file = join(tempDir(), 'settings.json');
  return planJsonEdits(file, edits, { read: () => contents });
}

describe('findJsoncSyntax', () => {
  it('finds a comment of either kind', () => {
    expect(findJsoncSyntax('{ // note\n "a": 1 }')).toBe('comment');
    expect(findJsoncSyntax('{ /* note */ "a": 1 }')).toBe('comment');
    expect(findJsoncSyntax('{ "a": 1 } // after')).toBe('comment');
    expect(findJsoncSyntax('// first line\n{}')).toBe('comment');
  });

  it('finds a comma before a closing bracket, whatever lies between', () => {
    expect(findJsoncSyntax('{"a": [1, 2,]}')).toBe('trailing-comma');
    expect(findJsoncSyntax('{"a": 1,}')).toBe('trailing-comma');
    expect(findJsoncSyntax('{\n  "a": 1,\n}\n')).toBe('trailing-comma');
    expect(findJsoncSyntax('{"a": [1,\t\r\n ]}')).toBe('trailing-comma');
  });

  // A tokenizer, not a pattern over the whole file: a string is a string.
  it.each([
    ['a URL', '{"u": "https://example.invalid/path"}'],
    ['two slashes', '{"p": "a//b"}'],
    ['the start of a block comment', '{"p": "/* not a comment */"}'],
    ['a comma and a bracket', '{"p": "a,]" , "q": "b,}"}'],
    ['an escaped quote then slashes', '{"p": "say \\"//\\" twice"}'],
    ['a string ending in an escaped backslash', '{"p": "C:\\\\", "q": "//"}'],
    ['an escaped slash', '{"p": "a\\/\\/b"}'],
    ['unicode', '{"p": "é // ü", "q": "\u{1f600}/*"}'],
  ])('does not take %s inside a string for a comment or a comma', (_name, doc) => {
    expect(findJsoncSyntax(doc)).toBeNull();
    expect(() => JSON.parse(doc)).not.toThrow();
  });

  it('is null for ordinary JSON and for text that is not JSON at all', () => {
    expect(findJsoncSyntax('{"a": [1, 2, {"b": null}], "c": "d"}')).toBeNull();
    expect(findJsoncSyntax('')).toBeNull();
    expect(findJsoncSyntax('not json, at all')).toBeNull();
  });

  it('stays linear on long runs of commas and slashes', () => {
    const started = cpuNow();
    findJsoncSyntax(`[${',  '.repeat(300_000)}1]`);
    findJsoncSyntax(`"${'/'.repeat(500_000)}`);
    findJsoncSyntax('/'.repeat(500_000));
    expect(cpuNow() - started).toBeLessThan(20_000);
  });
});

describe('planJsonEdits: files it will not rewrite', () => {
  it.each([
    ['a line comment', '{\n  // keep this\n  "permissions": {}\n}\n'],
    ['a block comment', '{\n  /* keep this */\n  "permissions": {}\n}\n'],
    ['a comment after the last line', '{\n  "permissions": {}\n}\n// the end\n'],
    ['a trailing comma in an object', '{\n  "permissions": {},\n}\n'],
    ['a trailing comma in an array', '{\n  "list": [1, 2,\n  ]\n}\n'],
  ])('refuses a file with %s, and leaves it exactly as it is', (_name, before) => {
    const result = plan(before);

    expect(result.refused).toBe('jsonc');
    expect(result.after).toBe(before);
    expect(result.before).toBe(before);
    expect(result.changed).toBe(false);
    expect(result.diff).toBe('');
    expect(result.edits).toEqual([]);
    expect(result.refusedDetail).toMatch(/comment|comma/);
  });

  it('does not refuse a file for what is inside its strings', () => {
    const before =
      '{\n  "url": "https://example.invalid/a//b",\n  "note": "/* x */ , ]",\n  "permissions": {}\n}\n';

    const result = plan(before);

    expect(result.refused).toBeUndefined();
    expect(JSON.parse(result.after)).toMatchObject({
      url: 'https://example.invalid/a//b',
      note: '/* x */ , ]',
      permissions: { deny: ['x'] },
    });
  });

  it.each([
    ['an array', '[1, 2]\n'],
    ['a string', '"settings"\n'],
    ['a number', '42\n'],
    ['null', 'null\n'],
    ['true', 'true\n'],
  ])('refuses a file that is %s, not an object', (_name, before) => {
    const result = plan(before);

    expect(result.refused).toBe('not-object');
    expect(result.after).toBe(before);
    expect(result.changed).toBe(false);
  });

  it('refuses a file that is not JSON, without quoting any of it', () => {
    const before = '//registry.npmjs.org/:_authToken=npm_SECRETSECRETSECRET\n';

    const result = plan(before);

    // A comment, as far as the tokenizer can tell; either way, it is not rewritten and not quoted.
    expect(['jsonc', 'invalid-json']).toContain(result.refused);
    expect(result.refusedDetail ?? '').not.toContain('npm_');
    expect(result.refusedDetail ?? '').not.toContain('registry');
    const broken = plan('{"a": tokenSECRETSECRET,\n');
    expect(broken.refused).toBe('invalid-json');
    expect(broken.refusedDetail).not.toContain('SECRET');
    expect(broken.after).toBe('{"a": tokenSECRETSECRET,\n');
  });

  it('refuses text that was not valid UTF-8, which cannot be written back as it was', () => {
    const result = plan('{"a": "\uFFFD"}\n');

    expect(result.refused).toBe('not-utf8');
    expect(result.changed).toBe(false);
  });

  it('refuses, and does not throw, a document nested far deeper than any config is', () => {
    const deep = `{"a":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;

    const result = plan(deep);

    expect(result.refused).toBe('invalid-json');
    expect(result.after).toBe(deep);
  });

  describe('when an edit does not fit the file', () => {
    it.each([
      ['an array', '{"permissions": []}', 'permissions is not an object'],
      ['a string', '{"permissions": "all"}', 'permissions is not an object'],
      ['null', '{"permissions": null}', 'permissions is not an object'],
      ['a number', '{"permissions": 3}', 'permissions is not an object'],
    ])('refuses to go through %s on the way to the array', (_name, before, detail) => {
      const result = plan(before);

      expect(result.refused).toBe('type-conflict');
      expect(result.refusedDetail).toBe(detail);
      expect(result.after).toBe(before);
      expect(result.changed).toBe(false);
    });

    it('refuses to add to something that is not an array', () => {
      const result = plan('{"permissions": {"deny": "Read(x)"}}');

      expect(result.refused).toBe('type-conflict');
      expect(result.refusedDetail).toBe('permissions.deny is not an array');
    });

    it('refuses to set a value inside something that is not an object', () => {
      const result = plan('{"sandbox": [1]}', [
        { kind: 'json-set', path: ['sandbox', 'on'], value: true },
      ]);

      expect(result.refused).toBe('type-conflict');
      expect(result.refusedDetail).toBe('sandbox is not an object');
    });

    it('refuses the whole plan, not just the edit that does not fit', () => {
      const before = '{"a": {}, "permissions": "no"}';

      const result = plan(before, [
        { kind: 'json-set', path: ['a', 'ok'], value: 1 },
        addDeny('x'),
      ]);

      expect(result.refused).toBe('type-conflict');
      expect(result.after).toBe(before);
      expect(result.edits).toEqual([]);
    });

    it('never names a value in what it says', () => {
      const result = plan('{"permissions": "stroq_attack_fixture_value_0123456789"}');

      expect(result.refusedDetail).not.toContain('stroq_attack_');
    });
  });
});

describe('planJsonEdits: it only reads', () => {
  it('writes nothing, not even the directory a new file would go in', () => {
    const dir = tempDir();
    const file = join(dir, 'not', 'yet', 'settings.json');

    planJsonEdits(file, [addDeny('x')], { read: () => null });

    expect(readdirSync(dir)).toEqual([]);
  });

  it('leaves an existing file with the same bytes and the same modification time', () => {
    const dir = tempDir();
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"a": 1}\n');
    const beforeFd = openSync(file, 'r');
    try {
      const before = fstatSync(beforeFd);

      planJsonEdits(file, [addDeny('x')], { read: (path) => readFileSync(path, 'utf8') });

      expect(readFileSync(beforeFd, 'utf8')).toBe('{"a": 1}\n');
      expect(lstatSync(file)).toMatchObject({
        dev: before.dev,
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      });
    } finally {
      closeSync(beforeFd);
    }
    expect(readdirSync(dir)).toEqual(['settings.json']);
  });

  it.skipIf(process.platform === 'win32')(
    'asks for the file by its real path, with every link followed',
    () => {
      const dir = tempDir();
      const real = join(dir, 'dotfiles', 'settings.json');
      const link = join(dir, 'home', 'settings.json');
      mkdirSync(dirname(real), { recursive: true });
      mkdirSync(dirname(link), { recursive: true });
      writeFileSync(real, '{}\n');
      symlinkSync(real, link);
      const asked: string[] = [];

      const result = planJsonEdits(link, [addDeny('x')], {
        read: (path) => {
          asked.push(path);
          return readFileSync(path, 'utf8');
        },
      });

      expect(asked).toEqual([real]);
      expect(result.real).toBe(real);
      expect(result.file).toBe(link);
    },
  );

  it('does not change the edits it was given, and does not share their arrays', () => {
    const path = Object.freeze(['permissions', 'deny']);
    const value = Object.freeze({ a: Object.freeze([1]) });
    const edit: JsonEdit = Object.freeze({ kind: 'json-array-add', path, value });

    const result = plan('{}\n', [edit]);

    expect(result.edits[0]?.path).toEqual(['permissions', 'deny']);
    expect(result.edits[0]?.path).not.toBe(path);
    expect(result.edits[0]?.kind === 'json-array-add' && result.edits[0].value).not.toBe(value);
  });

  it('does not share the plan between two calls', () => {
    const file = join(tempDir(), 'settings.json');
    const first = planJsonEdits(file, [addDeny('x')], { read: () => '{}\n' });
    const second = planJsonEdits(file, [addDeny('x')], { read: () => '{}\n' });

    expect(first).toEqual(second);
    expect(first.edits).not.toBe(second.edits);
    expect(first.edits[0]).not.toBe(second.edits[0]);
  });
});

describe('planJsonEdits: edits that make no sense', () => {
  const rejected = (edit: unknown): unknown => {
    try {
      plan('{}\n', [edit as JsonEdit]);
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it.each([
    ['an empty path', { kind: 'json-set', path: [], value: 1 }],
    ['a path part that is not a string', { kind: 'json-set', path: ['a', 1], value: 1 }],
    ['an empty path part', { kind: 'json-set', path: ['a', ''], value: 1 }],
    ['a value that is undefined', { kind: 'json-set', path: ['a'], value: undefined }],
    ['a value that is not finite', { kind: 'json-set', path: ['a'], value: Number.NaN }],
    ['a function as a value', { kind: 'json-set', path: ['a'], value: () => 1 }],
    ['a value nested far too deep', { kind: 'json-set', path: ['a'], value: deepValue(500) }],
    ['a kind it does not know', { kind: 'json-delete', path: ['a'], value: 1 }],
  ])('rejects %s with a typed error', (_name, edit) => {
    const error = rejected(edit);

    expect(error).toBeInstanceOf(HardenError);
    expect(error).toMatchObject({ code: 'invalid-edit' });
  });
});

function deepValue(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe('planJsonEdits: keys that are not what they look like', () => {
  // `obj['__proto__'] = x` sets a prototype instead of a key. Edits are built with computed keys
  // in literals, which define a property, so the key is written as the file's key and nothing else.
  it('writes __proto__ as an ordinary key and pollutes nothing', () => {
    const result = plan('{}\n', [
      { kind: 'json-set', path: ['__proto__', 'polluted'], value: true },
    ]);

    const parsed = JSON.parse(result.after) as object;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(result.after).toContain('"__proto__"');
  });

  it('does not take a key from the prototype chain for one the file has', () => {
    const result = plan('{}\n', [
      { kind: 'json-array-add', path: ['constructor', 'list'], value: 1 },
    ]);

    expect(JSON.parse(result.after)).toEqual({ constructor: { list: [1] } });
    expect(result.edits[0]).toMatchObject({ createdFrom: 0 });
  });
});

describe('deepEqual', () => {
  it('compares values the way JSON does', () => {
    expect(deepEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(deepEqual('1', 1)).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual({}, [])).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual([], [])).toBe(true);
  });
});
