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
    ["import from from 'm'", ['m']],
    ["import * as from from 'm'", ['m']],
    ["import from, { a } from 'm'", ['m']],
    ["import { a as from } from 'm'", ['m']],
    ["import d, * as from from 'm'", ['m']],
    ["export * as from from 'm'", ['m']],
    ["export { from } from 'm'", ['m']],
    ["export { a as from } from 'm'", ['m']],
    ["\\u0072equire('a')", ['a']],
    ["req\\u0075ire('a')", ['a']],
    ["\\u{72}equire('a')", ['a']],
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

  describe('with the slash read as Node reads it', () => {
    it.each([
      // The shapes that made a reader divide where Node starts a regular expression, and the reverse.
      "if (a) /[//]/.test(b); require('pkg');",
      "if (a) /'/.test(b); require('pkg'); c = '/'",
      'while (a) /"/.test(b); require(\'pkg\'); c = "/"',
      "for (;;) /`/.test(b); require('pkg'); c = `/`",
      "for (var k in o) /'/.test(k); require('pkg'); c = '/'",
      "with (o) /'/.test(k); require('pkg'); c = '/'",
      "do /'/.test(b); while (0); require('pkg'); c = '/'",
      "if (a) ; else /'/.test(b); require('pkg'); c = '/'",
      "if (a) b(); else if (c) /'/.test(d); require('pkg'); c = '/'",
      "{}\n/a*/.test(1); require('pkg'); x = function(){} / 2;",
      "{}\n/[//]/.test(1); require('pkg');",
      "if (a) {}\n/'/.test(b); require('pkg'); c = '/'",
      "function f(){}\n/'/.test(a); require('pkg'); c = '/'",
      "x = 1; function f(){}\n/'/.test(a); require('pkg'); c = '/'",
      "class A {}\n/'/.test(a); require('pkg'); c = '/'",
      "try {} catch (e) {}\n/'/.test(a); require('pkg'); c = '/'",
      "try {} finally {}\n/'/.test(a); require('pkg'); c = '/'",
      "for (x of /a/.source) {} require('pkg')",
      "var f = function(){} / 2; require('pkg'); var q = 3 / 1;",
      "var f = (function(){}) / 2; require('pkg'); var q = 3 / 1;",
      "var o = {} / 2; require('pkg'); var q = 3 / 1;",
      "var o = {a: {}} / 2; require('pkg'); var q = 3 / 1;",
      "var c = class {} / 2; require('pkg'); var q = 3 / 1;",
      "x = () => {}\n/'/.test(a); require('pkg'); c = '/'",
      "var a = {default: 4}; var y = a.default /2; require('pkg') /*/ x */",
      "var a = {}; var y = a.delete /2; require('pkg') /*/ x */",
      "var a = {}; var y = a.in /2; require('pkg') /*/ x */",
      "var a = {}; var y = a.of /2; require('pkg') /*/ x */",
      "var a = {}; var y = a.yield /2; require('pkg') /*/ x */",
      "var a = {}; var y = a?.default /2; require('pkg') /*/ x */",
      "class A { #typeof = 1; m() { return this.#typeof /2; } } require('pkg'); var q = 3 / 1;",
      "var a = 4; a++ / 2 / 3; require('pkg'); var q = 3 / 1;",
      "var a = 4; a-- /2; require('pkg') /*/ x */",
      "var a = [4]; var y = a[0] / 2 / 3; require('pkg'); var q = 3 / 1;",
      "var r = /[/*]/; require('pkg') /* c */",
      "var r = /[/]/; require('pkg') /*/ x */",
      "var t = `${ /'/.test(a) + require('pkg') + /'/.source }`;",
      'var t = `${ /"/.test(a) }`; require(\'pkg\'); c = "/"',
      "var t = `${`${ /'/.test(a) }`}`; require('pkg'); c = '/'",
      "x = typeof /'/; require('pkg'); c = '/'",
      "x = a ? /'/ : /\"/; require('pkg')",
      "x = a || /'/.source; require('pkg'); c = '/'",
      "x = !/'/.test(a); require('pkg'); c = '/'",
      "x = a\n/c/g; require('pkg'); y = '/'",
      "x = this / 2 / 3; require('pkg'); y = null / 2 / 3;",
      "return /'/.test(a), require('pkg'), '/'",
      "x = a => /'/.test(a); require('pkg'); c = '/'",
      "x = (a) => a / 2; require('pkg'); c = 3 / 1",
      "x = (a) / 2; s = 'str'; y = (b) / 3; require('pkg')",
    ])('finds the module in %j', (text) => {
      const scan = scanModules(text);

      expect(scan.specifiers, text).toEqual(['pkg']);
      expect(scan.concerns, text).toEqual([]);
    });

    it('reads a regular expression after of in the head of a for as one', () => {
      expect(specs("for (const k of /a/g.exec(x)) { } require('pkg') /*/ x */")).toEqual(['pkg']);
      expect(specs("for (var [a] of /'/.source) { } require('pkg'); var q = '/'")).toEqual(['pkg']);
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
    // A slash that the text before it does not decide.
    ['var of = 4, y = of /2; require("pkg") /*/ x */', 'doubt'],
    ['var yield = 4, y = yield /2; require("pkg") /*/ x */', 'doubt'],
    ['var await = 4, y = await /2; require("pkg") /*/ x */', 'doubt'],
    ['var async = 4, y = async /2; require("pkg") /*/ x */', 'doubt'],
    ['var get = 4, y = get /2; require("pkg") /*/ x */', 'doubt'],
    ['var set = 4, y = set /2; require("pkg") /*/ x */', 'doubt'],
    ['var let = 4, y = let /2; require("pkg") /*/ x */', 'doubt'],
    ["switch (a) { case 1: {} /'/.test(b); require('pkg'); var q = '/' }", 'doubt'],
    ["label: {}\n/'/.test(a); require('pkg'); b = '/'", 'doubt'],
    ["async function f() {}\n/'/.test(a); require('pkg'); b = '/'", 'doubt'],
    // Brackets that do not match: something earlier was read wrongly, or the text is not JavaScript.
    ['}', 'doubt'],
    [')', 'doubt'],
    [']', 'doubt'],
    ['(]', 'doubt'],
    ['{)', 'doubt'],
    ["require('a'", 'doubt'],
    ['f(a, b {', 'doubt'],
    ['(('.repeat(5000), 'doubt'],
    // An escape that is not an escape of a name.
    ['\\x41bc = 1', 'doubt'],
    ['a\\u00 = 1', 'doubt'],
    ['\\u{110000} = 1', 'doubt'],
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
    // A member written as a string, which a reader of names does not see.
    ['module["require"]("pkg")', 'dynamic-code'],
    ["module['require']('pkg')", 'dynamic-code'],
    ['process["binding"]("fs")', 'dynamic-code'],
    ['module.constructor["_load"]("pkg")', 'dynamic-code'],
    ["require('module')['createRequire'](f)('pkg')", 'dynamic-code'],
    ['x["eval"]("1")', 'dynamic-code'],
    ['x["Function"]("return 1")()', 'dynamic-code'],
    ['process["execPath"]', 'dynamic-code'],
    ['module[name]("pkg")', 'dynamic-code'],
    ['process[name]', 'dynamic-code'],
    ['global[name]', 'dynamic-code'],
    ['globalThis[name]("1")', 'dynamic-code'],
    ['module["req" + "uire"]("pkg")', 'dynamic-code'],
    // The loader itself.
    ['Module.prototype._compile = function (c) { return 1 }', 'dynamic-code'],
    ["Module._extensions['.js'] = function () {}", 'dynamic-code'],
    // eval and Function from the global object, and the constructor of a constructor.
    ['global.eval("1")', 'dynamic-code'],
    ['globalThis.eval("1")', 'dynamic-code'],
    ['window.eval("1")', 'dynamic-code'],
    ['self.eval("1")', 'dynamic-code'],
    ['this.eval("1")', 'dynamic-code'],
    ['globalThis.Function("return 1")()', 'dynamic-code'],
    ['global.Function("return 1")()', 'dynamic-code'],
    ['const F = Function; new F("return 1")', 'dynamic-code'],
    ['new (Function)("a", "return a")', 'dynamic-code'],
    ['x = Function', 'dynamic-code'],
    ['x = [Function]', 'dynamic-code'],
    ['f(Function)', 'dynamic-code'],
    ['[].constructor.constructor("return 1")()', 'dynamic-code'],
    ['({}).constructor.constructor("return 1")()', 'dynamic-code'],
    ['"".constructor.constructor("return 1")()', 'dynamic-code'],
    // Starting node with text to run.
    ['process.execPath', 'dynamic-code'],
    ['spawnSync(process.execPath, ["-e", "1"])', 'dynamic-code'],
    ['process.mainModule.require("pkg")', 'dynamic-code'],
    ['process.dlopen(m, f)', 'dynamic-code'],
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
    'typeof Function === "function"',
    'const f = Function.prototype',
    'Function.prototype.call.bind(x)',
    'Function.prototype.toString.call(f)',
    // eval or Function as a property of an object that is not the global one is that object's own business.
    'obj.eval(1)',
    'a.Function(1)',
    'x.constructor.name',
    'new this.constructor(a)',
    'this.constructor(a)',
    '["eval", "arguments"]',
    'const reserved = ["eval", "Function"]',
    'process["env"].X',
    'module.exports = 1',
    'module["exports"] = 1',
    'global.process.env',
    'process.env[name]',
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
    '#internal/thing',
  ])('%j is a built-in of Node, or a # import of the package', (spec) => {
    expect(classifySpecifier(spec)).toBe('inside');
    expect(isBareSpecifier(spec)).toBe(false);
  });

  it.each(['data:text/javascript,export default 1', 'data:,1'])(
    '%j is a data: URL, which is the text of a module and can import any URL',
    (spec) => {
      expect(classifySpecifier(spec)).toBe('data');
      expect(isBareSpecifier(spec)).toBe(false);
    },
  );

  it.each(['NODE:fs', 'Node:fs', 'DATA:text/javascript,1', 'FS', 'Path', 'fs/Promises'])(
    '%j is not a built-in of Node, because Node compares it as written',
    (spec) => {
      expect(classifySpecifier(spec)).toBe('bare');
    },
  );

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
    ['https://example.com/a.js', 'https://example.com/a.js'],
    ['npm:left-pad', 'npm:left-pad'],
    ['NODE:fs', 'NODE:fs'],
    ['DATA:text/javascript,1', 'DATA:text/javascript,1'],
  ])('%s is %s', (spec, name) => {
    expect(packageNameOf(spec)).toBe(name);
  });
});
