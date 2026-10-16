import { describe, expect, it } from 'vitest';
import {
  classifySpecifier,
  isBareSpecifier,
  moduleSpecifiers,
  packageNameOf,
  scanModules,
} from '../../../src/install/inspect/module-specifiers.js';

// Every string below is text for the scanner to read. None of it is run, evaluated or turned into a function.
const specs = (text: string): string[] => moduleSpecifiers(text);
const concernsOf = (text: string): string[] => [...scanModules(text).concerns];
/** Found, or the file is flagged: the two ways a reading is not "nothing here". */
const seen = (text: string, name: string): boolean => {
  const scan = scanModules(text);
  return scan.specifiers.includes(name) || scan.concerns.length > 0;
};

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
    ["import('a', { with: { type: 'json' } })", ['a']],
    ["require.resolve('a')", ['a']],
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
    expect(concernsOf(text)).toEqual([]);
  });

  describe('with comments, blanks and line breaks between the tokens', () => {
    it.each([
      "import\n/*x*/ ('pkg')",
      "import /*x*/ ( /*y*/ 'pkg' /*z*/ )",
      "require /*c*/ ('pkg')",
      "require\n('pkg')",
      "require // comment\n('pkg')",
      "require\u2028('pkg')",
      "require\u2029('pkg')",
      "require\r('pkg')",
      "require\u00a0('pkg')",
      "require\u2003('pkg')",
      "require\u3000('pkg')",
      "require\ufeff('pkg')",
      "require\t\v\f('pkg')",
      "import /*c*/ x /*d*/ from /*e*/ 'pkg'",
      "import\nx\nfrom\n'pkg'",
      'import {\n a, // c\n b /* d */ } from "pkg"',
      "import * /*c*/ as /*d*/ ns from 'pkg'",
      "export /*c*/ * /*d*/ from /*e*/ 'pkg'",
      "export {\n a,\n b\n}\nfrom 'pkg'",
      "\ufeffrequire('pkg')",
      "#!/usr/bin/env node\nrequire('pkg')",
      "// comment\u2028require('pkg')",
      "// comment\rrequire('pkg')",
      "/* comment */require('pkg')",
      "/* a\nb */require('pkg')",
      "const s = 'x';// '\nrequire('pkg')",
      "const t = `a`; /* ` */ require('pkg')",
    ])('finds pkg in %j', (text) => {
      expect(specs(text)).toEqual(['pkg']);
      expect(concernsOf(text)).toEqual([]);
    });
  });

  describe('and does not read what is only text', () => {
    it.each([
      "// import x from 'a'",
      "/* import x from 'a' */",
      "/* require('a')\n */ const x = 1",
      'const s = "require(\'a\')"',
      'const s = \'import x from "a"\'',
      "const s = `require('a')`",
      "const s = `import('a')`",
      "const s = `${1} require('a')`",
      "const r = /require('a')/",
      'const r = /[\'"]/; const x = 1',
      'const q = x / 2; const s = \'require("a")\'',
      "export const x = 1; const from = 'a'",
      "export { a }; const from = 'b'",
      "export function from(x) { return x } // from 'a'",
      'obj.import("a")',
      "obj.import = 'a'",
      'import.meta.url',
      'import.meta.dirname',
      "const name = 'import'; const other = 'from'",
      "#!/usr/bin/env node\n// require('a')",
      "'use strict'; // import('a')",
      '',
    ])('finds nothing in %j', (text) => {
      expect(specs(text)).toEqual([]);
      expect(concernsOf(text)).toEqual([]);
    });
  });

  it('is not led astray by a regular expression that holds a quote, a slash or a backtick', () => {
    for (const regex of [
      "/'/g",
      '/"/g',
      '/`/',
      '/[\'"]/',
      '/[/]/',
      '/a\\/b/',
      '/\\//',
      '/(?:)/',
      '/{/',
      '/}/',
    ]) {
      expect(specs(`const r = ${regex}; const x = require('pkg')`), regex).toEqual(['pkg']);
      expect(specs(`x = [${regex}, ${regex}]; require('pkg')`), regex).toEqual(['pkg']);
      expect(specs(`f(${regex}); return ${regex}.test(y) && require('pkg')`), regex).toEqual([
        'pkg',
      ]);
    }
  });

  it('is not led astray by a division', () => {
    for (const division of ['a / b', 'a/b/c', '(a + b) / 2', 'arr[0] / 2', '1 / 2', 'n++ / 2']) {
      const text = `const d = ${division}; const x = require('pkg')`;
      expect(seen(text, 'pkg'), division).toBe(true);
    }
    expect(specs("const d = a / b / c; require('pkg')")).toEqual(['pkg']);
    expect(specs("const d = 1 / 2; const e = x.y / z; require('pkg')")).toEqual(['pkg']);
  });

  it('lists each specifier once, in the order it first appears', () => {
    expect(specs("require('b'); require('a'); require('b'); import('a')")).toEqual(['b', 'a']);
  });

  it('flags a file that has more specifiers than it takes', () => {
    const text = Array.from({ length: 50 }, (_, i) => `require('m${i}');`).join('\n');
    const scan = scanModules(text, 10);

    expect(scan.specifiers).toHaveLength(10);
    expect(scan.concerns).toContain('doubt');
  });

  it('survives text that is not code', () => {
    const noise = ['{', '}', '`', '${', '/*', '"', "'", '/', '\\', 'import', 'export', 'require'];
    for (const piece of noise) expect(() => scanModules(piece.repeat(500))).not.toThrow();
    expect(() => scanModules('\u0000\ud800\u{1f600}'.repeat(100))).not.toThrow();
  });
});

describe('what the reading cannot settle is a concern, never an empty list', () => {
  it.each([
    // The lexer cannot be sure what the text is.
    ["const s = 'unclosed\nconst x = require('a')", 'doubt'],
    ["const s = 'unclosed", 'doubt'],
    ['const s = "unclosed', 'doubt'],
    ['/* unclosed comment require("a")', 'doubt'],
    ['const t = `unclosed require("a")', 'doubt'],
    ['const t = `${require("a")', 'doubt'],
    ['const r = /unclosed', 'doubt'],
    ["const r = /unclosed\nrequire('a')", 'doubt'],
    ["<!-- require('a')", 'doubt'],
    ["x = 1 <!-- require('a')", 'doubt'],
    ["x = 1\n--> require('a')", 'doubt'],
    ["/* c */ --> require('a')", 'doubt'],
    ["\\u0072equire('a')", 'doubt'],
    ["req\\u0075ire('a')", 'doubt'],
    ["if (a) /'/.test(b); require('pkg'); c = '/'", 'doubt'],
    ['if (a) /"/.test(b); require(\'pkg\'); c = "/"', 'doubt'],
    ["x = (a) / 2; s = 'str'; y = (b) / 3; require('pkg')", 'doubt'],
    ["}\n/'/.test(a); require('pkg'); b = '/'", 'doubt'],
    [`${'`${'.repeat(100)}`, 'doubt'],
    // A module asked for by a name that is built at run time.
    ['require(name)', 'computed'],
    ["require('a' + b)", 'computed'],
    ['require(`a${b}`)', 'computed'],
    ['require()', 'computed'],
    ['import(name)', 'computed'],
    ["import('a' + b)", 'computed'],
    ['import(`a${b}`)', 'computed'],
    ['module.require(name)', 'computed'],
    ['require.resolve(name)', 'computed'],
    ['require.cache[id]', 'computed'],
    ["import.meta.resolve('pkg')", 'computed'],
    // `require` used as a value.
    ["const r = require; r('pkg')", 'computed'],
    ["const load = require\nload('pkg')", 'computed'],
    ["[require][0]('pkg')", 'computed'],
    ["require?.('pkg')", 'computed'],
    ["(0, require)('pkg')", 'computed'],
    ['f(require)', 'computed'],
    ['const x = { require }', 'computed'],
    ['require', 'computed'],
    ["require('pkg'", 'computed'],
    // Loading with no module name in the text.
    ["const { createRequire } = require('module')", 'dynamic-code'],
    ["import { createRequire } from 'node:module'", 'dynamic-code'],
    ["createRequire(import.meta.url)('pkg')", 'dynamic-code'],
    ["module.createRequire(__filename)('pkg')", 'dynamic-code'],
    ["Module._load('pkg')", 'dynamic-code'],
    ["Module._resolveFilename('pkg')", 'dynamic-code'],
    ["process.binding('natives')", 'dynamic-code'],
    ['process.dlopen(module, file)', 'dynamic-code'],
    ['eval("require(\'pkg\')")', 'dynamic-code'],
    ['(0, eval)("1")', 'dynamic-code'],
    ['new Function(\'return require("pkg")\')()', 'dynamic-code'],
    ["Function('return 1')()", 'dynamic-code'],
    ['new Function(...args, body)', 'dynamic-code'],
    // A module name written with escapes is not the name the text shows.
    ["require('\\x70kg')", 'escaped'],
    ["require('p\\u006bg')", 'escaped'],
    ["require('p\\u{6b}g')", 'escaped'],
    ['require(`\\x70kg`)', 'escaped'],
    ["import('p\\x6bg')", 'escaped'],
    ['import "\\x70kg"', 'escaped'],
    ['import x from "\\x70kg"', 'escaped'],
    ['export * from "p\\x6bg"', 'escaped'],
    ["require('pkg\\\n')", 'escaped'],
  ] as const)('%j is flagged as %s', (text, concern) => {
    const scan = scanModules(text);

    expect(scan.concerns, text).toContain(concern);
  });

  it('never reads a file with a concern as one with no imports', () => {
    for (const text of [
      "if (a) /'/.test(b); require('pkg'); c = '/'",
      "<!-- \nrequire('pkg')",
      "require('pkg' + x)",
      "createRequire(import.meta.url)('pkg')",
    ])
      expect(seen(text, 'pkg'), text).toBe(true);
  });

  it.each([
    "typeof require === 'function'",
    'typeof require !== "undefined" ? 1 : 2',
    'if (require.main === module) { main() }',
    'const m = require.main',
    'x instanceof Function',
    'const f = Function.prototype',
    'obj.eval(1)',
    'a.Function(1)',
    'x.binding',
    'const binding = 1',
    'const resolve = (a, b) => a',
    'p.resolve(1)',
    'process.env.X',
    'const createRequireLater = 1',
    'import.meta.url',
    'const i = x++ / 2',
  ])('does not flag %j', (text) => {
    expect(concernsOf(text)).toEqual([]);
  });
});

describe('how a specifier is looked up', () => {
  it.each(['zod', 'zod/v4', '@scope/pkg', '@scope/pkg/sub/path', 'lodash.merge', 'a-b_c'])(
    '%s is a package, looked up by name',
    (spec) => {
      expect(classifySpecifier(spec)).toBe('bare');
      expect(isBareSpecifier(spec)).toBe(true);
    },
  );

  it.each(['./a.js', '../a.js', '.', '..', '', './', '../'])('%j is relative', (spec) => {
    expect(classifySpecifier(spec)).toBe('relative');
    expect(isBareSpecifier(spec)).toBe(false);
  });

  it.each([
    '/abs/a.js',
    'C:\\abs\\a.js',
    'C:/abs/a.js',
    '\\\\server\\share\\a.js',
    'file:///abs/a.js',
    'FILE:///abs/a.js',
  ])('%j is absolute, a place outside any tree', (spec) => {
    expect(classifySpecifier(spec)).toBe('absolute');
    expect(isBareSpecifier(spec)).toBe(false);
  });

  it.each([
    'node:fs',
    'node:test/reporters',
    'node:sqlite',
    'fs',
    'fs/promises',
    'path',
    'child_process',
    'data:text/javascript,export default 1',
    '#internal/thing',
  ])('%j is Node\u2019s own, or the package\u2019s', (spec) => {
    expect(classifySpecifier(spec)).toBe('inside');
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
