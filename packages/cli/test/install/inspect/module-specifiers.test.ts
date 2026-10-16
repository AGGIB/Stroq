import { describe, expect, it } from 'vitest';
import {
  isBareSpecifier,
  moduleSpecifiers,
  packageNameOf,
} from '../../../src/install/inspect/module-specifiers.js';

const specs = (text: string): string[] => moduleSpecifiers(text);

describe('the module specifiers a JavaScript file asks for', () => {
  it.each([
    ["import x from 'a'", ['a']],
    ['import x from "a"', ['a']],
    ["import { a, b as c } from 'm'", ['m']],
    ["import * as ns from 'm'", ['m']],
    ["import d, { a } from 'm'", ['m']],
    ["import d, * as ns from 'm'", ['m']],
    ["import 'side-effect'", ['side-effect']],
    ["import type { T } from 'types-only'", ['types-only']],
    ["import { default as x } from 'm'", ['m']],
    ["import { from } from 'm'", ['m']],
    ["import { 'a string name' as x } from 'm'", ['m']],
    ["import x from 'a' with { type: 'json' }", ['a']],
    ["export * from 'm'", ['m']],
    ["export * as ns from 'm'", ['m']],
    ["export { a, b } from 'm'", ['m']],
    ["export { default } from 'm'", ['m']],
    ["const x = require('a')", ['a']],
    ['const x = require("a")', ['a']],
    ["const x = require( 'a' )", ['a']],
    ['const x = require(`a`)', ['a']],
    ["module.require('a')", ['a']],
    ["const m = await import('a')", ['a']],
    ["import('a').then(f)", ['a']],
    ["import(\n  'a'\n)", ['a']],
    ["const { a } = require('x'), b = require('y')", ['x', 'y']],
    ["import a from 'one'; import b from 'two'", ['one', 'two']],
    ["import {\n  a,\n  b,\n} from 'multi'", ['multi']],
    ["import a from 'a';\nexport { a } from 'b';\nrequire('c');", ['a', 'b', 'c']],
    ["const t = `${require('inside')}`", ['inside']],
    ["const t = `${`${require('nested')}`}`", ['nested']],
    ["if (x) { require('a') } else { require('b') }", ['a', 'b']],
    ["foo(() => import('lazy'))", ['lazy']],
  ] as const)('finds the specifiers of %j', (text, expected) => {
    expect(specs(text)).toEqual(expected);
  });

  it.each([
    "// import x from 'a'",
    "/* import x from 'a' */",
    "/* require('a')\n */ const x = 1",
    'const s = "require(\'a\')"',
    'const s = \'import x from "a"\'',
    "const s = `require('a')`",
    "const s = `import('a')`",
    "const r = /require('a')/",
    'const r = /[\'"]/; const x = 1',
    'const q = x / 2; const s = \'require("a")\'',
    "export const x = 1; const from = 'a'",
    "export { a }; const from = 'b'",
    "export function from(x) { return x } // from 'a'",
    "obj.import('a')",
    "obj.import = 'a'",
    'import.meta.url',
    "const name = 'import'; const other = 'from'",
    'require',
    'require(name)',
    'import(name)',
    'import(`a${b}`)',
    "require('a' + b)",
    "#!/usr/bin/env node\n// require('a')",
    '',
  ])('finds nothing in %j', (text) => {
    expect(specs(text)).toEqual([]);
  });

  it('finds an import that follows a regular expression holding a quote', () => {
    expect(specs("const r = /'/g; const x = require('a')")).toEqual(['a']);
    expect(specs("const r = /[/']/; require('b')")).toEqual(['b']);
  });

  it('keeps a string that is not closed to its own line', () => {
    expect(specs("const s = 'unclosed\nconst x = require('a')")).toEqual(['a']);
  });

  it('lists each specifier once, in the order it first appears', () => {
    expect(specs("require('b'); require('a'); require('b'); import('a')")).toEqual(['b', 'a']);
  });

  it('stops listing at the limit it is given', () => {
    const text = Array.from({ length: 50 }, (_, i) => `require('m${i}');`).join('\n');

    expect(moduleSpecifiers(text, 10)).toHaveLength(10);
  });

  it('survives text that is not code', () => {
    const noise = ['{', '}', '`', '${', '/*', '"', "'", '/', '\\', 'import', 'export', 'require'];
    for (const piece of noise) expect(() => specs(piece.repeat(500))).not.toThrow();
    expect(() => specs('\u0000\ud800\u{1f600}'.repeat(100))).not.toThrow();
  });
});

describe('which specifiers are bare', () => {
  it.each(['zod', 'zod/v4', '@scope/pkg', '@scope/pkg/sub/path', 'lodash.merge', 'a-b_c'])(
    '%s is looked up by name',
    (spec) => {
      expect(isBareSpecifier(spec)).toBe(true);
    },
  );

  it.each([
    './a.js',
    '../a.js',
    '.',
    '..',
    '/abs/a.js',
    'C:\\abs\\a.js',
    'C:/abs/a.js',
    '\\\\server\\share\\a.js',
    'node:fs',
    'node:test/reporters',
    'fs',
    'fs/promises',
    'path',
    'child_process',
    'node:sqlite',
    'file:///abs/a.js',
    'data:text/javascript,export default 1',
    '#internal/thing',
    '',
  ])('%j is not', (spec) => {
    expect(isBareSpecifier(spec)).toBe(false);
  });

  it('counts a URL scheme node cannot load, and a package-manager scheme, as outside the tree', () => {
    expect(isBareSpecifier('https://example.com/a.js')).toBe(true);
    expect(isBareSpecifier('npm:left-pad')).toBe(true);
  });
});

describe('the package a specifier names', () => {
  it.each([
    ['zod', 'zod'],
    ['zod/v4', 'zod'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/deep/path.js', '@scope/pkg'],
    ['@scope', '@scope'],
  ])('%s is %s', (spec, name) => {
    expect(packageNameOf(spec)).toBe(name);
  });
});
