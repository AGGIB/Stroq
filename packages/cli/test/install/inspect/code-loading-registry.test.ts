import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_NAMES,
  GLOBAL_MEMBERS,
  LOADER_NAMES,
  LOOKUP_MEMBERS,
  MODULE_ONLY_NAMES,
  NODE_FLAGS,
  NODE_FLAG_PREFIXES,
  PROCESS_MEMBERS,
  RUNNERS,
  RUNS_TEXT_MODULES,
  SPAWNING_MODULES,
  WRITERS,
} from '../../../src/install/inspect/code-loading-registry.js';
import { commandRunsNodeCode } from '../../../src/install/inspect/code-loading.js';
import { cookString } from '../../../src/install/inspect/js-lexer.js';
import { outsideImportsOfTree } from '../../../src/install/inspect/imports.js';
import { scanModules } from '../../../src/install/inspect/module-specifiers.js';
import { buildTree } from '../../../src/install/tree.js';
import { fileEntry } from '../../helpers/install-tree.js';

/**
 * The registry of what runs text as code or loads code by name (`code-loading-registry.ts`), held to the reading of
 * it. Each entry is written in every spelling the reading handles and must be found, and the same words in a place
 * where they are only words must not be. The tables are built from the registry itself, so an entry that is added to
 * it without a reading that finds it fails here, and the guide must name every entry.
 */
const concernsOf = (text: string): readonly string[] => scanModules(text).concerns;
const flagged = (text: string): boolean => concernsOf(text).length > 0;
/** As `add` reads a file: the whole reading, with the module-level rules. */
const fileFlagged = (text: string): boolean =>
  outsideImportsOfTree(buildTree([fileEntry('server.js', text)], { complete: true })).concerns
    .length > 0;

/** The first letter written as an identifier escape: `\u0065val`. */
const escapedIdentifier = (name: string): string =>
  `\\u${name.charCodeAt(0).toString(16).padStart(4, '0')}${name.slice(1)}`;
const hexString = (name: string): string =>
  `\\x${name.charCodeAt(0).toString(16).padStart(2, '0')}${name.slice(1)}`;
const unicodeString = (name: string): string =>
  `\\u${name.charCodeAt(0).toString(16).padStart(4, '0')}${name.slice(1)}`;
const bracedString = (name: string): string =>
  `\\u{${name.charCodeAt(0).toString(16)}}${name.slice(1)}`;

describe('the names that load code wherever they stand', () => {
  describe.each(LOADER_NAMES.map((entry) => [entry.name, entry.does] as const))('%s', (name) => {
    it.each([
      ['a member call', `x.${name}(1)`],
      ['a free call', `${name}(1)`],
      ['an optional call', `x?.${name}(1)`],
      ['a name taken out by a pattern', `const { ${name} } = x`],
      ['a property key', `({ ${name}: 1 })`],
      ['a shorthand property', `({ ${name} })`],
      ['a string in brackets', `x['${name}']`],
      ['a double-quoted string in brackets', `x["${name}"]`],
      ['a template in brackets', `x[\`${name}\`]`],
      ['a string with a hex escape', `x['${hexString(name)}']`],
      ['a string with a unicode escape', `x['${unicodeString(name)}']`],
      ['a string with a braced escape', `x['${bracedString(name)}']`],
      ['an identifier with an escape', `x.${escapedIdentifier(name)}(1)`],
    ])('is found as %s', (_how, text) => {
      expect(flagged(text), text).toBe(true);
    });

    it.each([
      ['a comment', `// ${name}(1)\nvar a = 1`],
      ['a block comment', `/* ${name} */ var a = 1`],
      ['a string that is not a member', `var s = '${name}'`],
      ['a string in a list', `var l = ['${name}', 'other']`],
      ['a string key', `var o = { '${name}': 1 }`],
      [
        'the name in another case',
        `x.${name.toUpperCase()}(1); x.${name.toLowerCase() === name ? name.toUpperCase() : name.toLowerCase()}(2)`,
      ],
      ['the name with a letter more', `x.${name}s(1); x.my${name}(2)`],
    ])('is not found in %s', (_how, text) => {
      expect(flagged(text), text).toBe(false);
    });
  });
});

describe('the members of process', () => {
  describe.each(PROCESS_MEMBERS.map((entry) => entry.name))('%s', (name) => {
    it.each([
      ['a member', `process.${name}`],
      ['an optional member', `process?.${name}`],
      ['a string in brackets', `process['${name}']`],
      ['a double-quoted string in brackets', `process["${name}"]`],
      ['a template in brackets', `process[\`${name}\`]`],
      ['a string with a hex escape', `process['${hexString(name)}']`],
      ['a string with a unicode escape', `process['${unicodeString(name)}']`],
      ['an identifier with an escape', `process.${escapedIdentifier(name)}`],
      ['a member of an alias', `const p = process; p.${name}`],
      ['a member of an alias of an alias', `const p = process; const q = p; q.${name}`],
      ['a member of an alias assigned later', `let p; p = process; p.${name}`],
      ['a string on an alias', `const p = process; p['${name}']`],
      ['a member of the process of the global object', `globalThis.process.${name}`],
      ['a string on the process of the global object', `global.process['${name}']`],
      ['a name taken out by a pattern', `const { ${name} } = process`],
      ['a name taken out with others', `const { a, ${name}, b } = process`],
      ['a name taken out and renamed', `const { ${name}: z } = process`],
      ['a pattern on an alias', `const p = process; const { ${name} } = p`],
    ])('is found as %s', (_how, text) => {
      expect(flagged(text), text).toBe(true);
    });

    it.each([
      ['a member of another object', `obj.${name}`],
      ['a variable of that name', `const ${name} = 1; ${name} + 1`],
      ['a member of something that is not an alias', `const p = other; p.${name}`],
      ['a string that is not a member', `var s = '${name}'`],
      ['a pattern on another object', `const { ${name} } = config`],
      ['a pattern of members that are not the name', 'const { env, argv, exit } = process'],
    ])('is not found in %s', (_how, text) => {
      expect(flagged(text), text).toBe(false);
    });
  });

  it.each([
    ['a name made at run time', 'process[name]'],
    ['a name in pieces', "process['bind' + 'ing']"],
    ['a name from a template with a hole', 'process[`bind${x}`]'],
    ['a name made at run time on an alias', 'const p = process; p[name]'],
    ['a name made at run time on process of the global object', 'globalThis.process[name]'],
    ['a name picked by Reflect', 'Reflect.get(process, name)'],
    ['a name picked by Object', 'Object.getOwnPropertyDescriptor(process, name)'],
    ['a string with an escape that cannot be read', "process['\\x4']"],
  ])('is a concern as %s', (_how, text) => {
    expect(flagged(text), text).toBe(true);
  });

  it.each([
    'process.env.X',
    'process.env[name]',
    "process['env'].X",
    'process.argv[2]',
    'process.exit(1)',
    'process.stdout.write(s)',
    'process.nextTick(f)',
    'Object.keys(process.env)',
    'const { env } = process',
    'x.process[name]',
    'process.on("exit", f)',
  ])('is not a concern: %s', (text) => {
    expect(flagged(text), text).toBe(false);
  });
});

describe('eval and Function', () => {
  const receivers = ['globalThis', 'global', 'window', 'self', 'this'] as const;
  describe.each(GLOBAL_MEMBERS.map((entry) => entry.name))('%s', (name) => {
    it.each([
      ['a free call', `${name}('1')`],
      ['a comma expression', `(0, ${name})('1')`],
      ['an optional call', `${name}?.('1')`],
      ['a tagged template', `${name}\`1\``],
      ['an identifier with an escape', `${escapedIdentifier(name)}('1')`],
      ['an alias taken from a pattern', `const { ${name}: f } = x; f('1')`],
    ])('is found as %s', (_how, text) => {
      expect(flagged(text), text).toBe(true);
    });

    describe.each(receivers)('on %s', (receiver) => {
      it.each([
        ['a member', `${receiver}.${name}('1')`],
        ['an optional member', `${receiver}?.${name}('1')`],
        ['a string in brackets', `${receiver}['${name}']('1')`],
        ['a template in brackets', `${receiver}[\`${name}\`]('1')`],
        ['a string with a hex escape', `${receiver}['${hexString(name)}']('1')`],
        ['a string with a unicode escape', `${receiver}['${unicodeString(name)}']('1')`],
        ['an identifier with an escape', `${receiver}.${escapedIdentifier(name)}('1')`],
        ['a member of an alias', `const g = ${receiver}; g.${name}('1')`],
        ['a string on an alias', `var g = ${receiver}; g['${name}']('1')`],
        ['a member of an alias of an alias', `var g = ${receiver}; var h = g; h.${name}('1')`],
      ])('is found as %s', (_how, text) => {
        expect(flagged(text), text).toBe(true);
      });
    });

    it.each(['globalThis', 'global'])(
      'is found when picked from %s by Reflect or Object',
      (receiver) => {
        expect(flagged(`Reflect.get(${receiver}, '${name}')('1')`)).toBe(true);
        expect(flagged(`Reflect.get(${receiver}, 'ev' + 'al')('1')`)).toBe(true);
        expect(flagged(`Object.getOwnPropertyDescriptor(${receiver}, '${name}').value('1')`)).toBe(
          true,
        );
        expect(flagged(`Object.getOwnPropertyNames(${receiver})`)).toBe(true);
      },
    );

    it('is found when its name is built in pieces on the global object', () => {
      expect(flagged(`globalThis['${name.slice(0, 2)}' + '${name.slice(2)}']('1')`)).toBe(true);
      expect(flagged(`const g = global; g['${name.slice(0, 2)}' + '${name.slice(2)}']('1')`)).toBe(
        true,
      );
    });
  });

  it.each([
    'x instanceof Function',
    'typeof Function === "function"',
    'const f = Function.prototype',
    'Function.prototype.call.bind(x)',
    'Function.prototype.toString.call(f)',
    'const evaluate = 1',
    'function Functional(x) {}',
    'myeval(1)',
    'Eval(1)',
    'EVAL(1)',
    'eval2(1)',
    'globalthis.eval2(1)',
    'Global.evaluate(1)',
    '\\u0435val(1)',
  ])('is not a concern: %s', (text) => {
    expect(flagged(text), text).toBe(false);
  });

  it.each([
    ['new Function', 'new Function("return 1")'],
    ['Function called', 'Function("return 1")()'],
    ['Function.prototype.constructor', 'Function.prototype.constructor("return 1")()'],
    ['the constructor of a function value', '(function () {}).constructor("return 1")()'],
    ['the constructor of an async function value', '(async function () {}).constructor("1")'],
    ['the constructor of an arrow function value', 'const F = (() => {}).constructor; F("1")'],
    [
      'the constructor of a prototype',
      'Object.getPrototypeOf(async function () {}).constructor("1")',
    ],
    ['the constructor of a constructor', 'x.constructor.constructor("return 1")()'],
    ['the constructor of a constructor, by strings', 'x["constructor"]["constructor"]("1")'],
    [
      'the constructor of a constructor, by a string and a member',
      'x["constructor"].constructor("1")',
    ],
    [
      'the constructor of a constructor, by a member and a string',
      'x.constructor["constructor"]("1")',
    ],
    ['a string with an escape in the name', 'x["\\x63onstructor"]["constructor"]("1")'],
  ])('is found: %s', (_how, text) => {
    expect(flagged(text), text).toBe(true);
  });

  it.each([
    'this.constructor(a)',
    'new this.constructor(a)',
    'x.constructor.name',
    'error.constructor === TypeError',
    'Foo.prototype.constructor = Foo',
    'obj.constructor.prototype',
    'const c = obj.constructor',
  ])('does not take an ordinary constructor for the Function constructor: %s', (text) => {
    expect(flagged(text), text).toBe(false);
  });
});

describe('an identifier set to the global object, process or module', () => {
  // Setting a variable to `globalThis` or `process` is itself a concern, so what is followed here is the one way left to do
  // it unseen: `process || {}`, where the name is an operand and not yet a use.
  it.each([
    ['a const', 'const p = process || {}; p.binding("x")'],
    ['a let', 'let p = process || {}; p[name]'],
    ['a var', 'var p = process || {}; p[name]'],
    ['a plain assignment', 'p = process || {}; p[name]'],
    ['a declaration with other declarators', 'let a = 1, p = process || {}, b = 2; p[name]'],
    ['a block that has ended, when it is a var', '{ var p = process || {}; } p[name]'],
    ['a block that has ended, when it is an assignment', '{ p = process || {}; } p[name]'],
    ['an inner block', 'const p = process || {}; { p[name] }'],
    ['a function inside', 'const p = process || {}; function f() { return p[name] }'],
    ['a name built in pieces', 'const g = global || {}; g["ev" + "al"]'],
    ['an alias of an alias', 'const p = process || {}; const q = p || {}; q[name]'],
    ['an alias of the global object', 'const g = globalThis || {}; g[name]'],
    [
      'the same short name in a parameter, which is not told from the alias',
      'var t = process || {}; function f(t) { return t[name] }',
    ],
  ])('is followed through %s', (_how, text) => {
    expect(flagged(text), text).toBe(true);
  });

  it.each([
    ['a member of process, not process', 'const argv = process.argv; argv[i]'],
    ['a member of process, with a call', 'const e = process.env.X; e[0]'],
    ['a member of the global object', 'const c = globalThis.config; c[key]'],
    ['a member of module', 'const x = module.exports; x[key]'],
    ['a call on process', 'const s = process.cwd(); s[0]'],
    [
      'an alias that ended with its block',
      'function f() { const p = process || {}; return p.x } p[name]',
    ],
    [
      'a let that ended with its block, and the name used as a parameter',
      'function a() { let t = process || {}; return t.x } function b(t) { return t[e] }',
    ],
    ['a name set to something else after', 'let p = process || {}; p = other(); p[name]'],
    ['a name set to something else after, in minified form', 'var t=process||{};t=f();t[e]'],
    ['a name that is only compared', 'if (p == process) { p[name] }'],
  ])('is not followed through %s', (_how, text) => {
    expect(flagged(text), text).toBe(false);
  });
});

describe('the identifiers that are a concern in any position', () => {
  it.each([
    ['process handed on', 'f(process)'],
    ['process set to a variable', 'const p = process; use(p)'],
    ['process returned', 'function f() { return process }'],
    ['process in an array', 'const a = [process]'],
    ['process in an object', 'const o = { p: process }'],
    ['process as a shorthand property', 'const o = { process }'],
    ['a member that is not data', 'process.binding("x")'],
    ['a member that is not data, written as a string', 'process["binding"]'],
    ['a name made at run time', 'process[name]'],
    [
      'process taken from the module of that name',
      "const p = require('node:process'); p.binding('x')",
    ],
    [
      'process taken from the module of that name, by a name made at run time',
      "const p = require('process'); p[name]",
    ],
    ['require.main.require', "require.main.require('x')"],
    ['module handed on', 'f(module)'],
    [
      'a local variable called module, which is not told from the object',
      'const module = 1; module + 1',
    ],
    ['module set to a variable', 'const m = module; use(m)'],
    ['a member of module that is not exports', 'module.children'],
    ['a name of module made at run time', 'module[name]'],
    ['globalThis handed on', 'f(globalThis)'],
    ['globalThis set to a variable', 'const g = globalThis; use(g)'],
    ['global handed on', 'f(global)'],
    ['global returned', 'function f() { return global }'],
    ['a name of globalThis made at run time', 'globalThis[name]'],
    ['import.meta handed on', 'f(import.meta)'],
    ['a member of import.meta that is not a path', 'import.meta.resolve("x")'],
    ['a member of import.meta that is not a path, another', 'import.meta.env'],
    ['eval as a member of anything', 'obj.eval(1)'],
    ['Function as a member of anything', 'a.Function(1)'],
    ['__proto__ read', 'x.__proto__.y'],
    ['the constructor of an expression, handed on', 'f((() => {}).constructor)'],
    ['the constructor of a name, called', 'f.constructor("1")'],
    ['the constructor of a name, called with new', 'new obj.constructor()'],
    ['the constructor of a name, called through call', 'f.constructor.call(null, "1")'],
    ['a key called Function taken out by a pattern', 'const { Function: F } = x; F("1")'],
  ])('is a concern: %s', (_how, text) => {
    expect(flagged(text), text).toBe(true);
  });

  it.each([
    ['typeof process', 'typeof process !== "undefined"'],
    ['typeof module', 'typeof module !== "undefined" && module.exports'],
    ['process imported by name', "import process from 'node:process'; process.env.X"],
    ['process imported as a namespace', "import * as process from 'node:process'; process.cwd()"],
    [
      'data taken from the module of that name',
      "const p = require('node:process'); p.env.X; p.argv",
    ],
    ['a choice with a key and a ternary', 'const o = { a: x ? process : void 0 }'],
    ['typeof globalThis', 'typeof globalThis !== "undefined"'],
    ['a key in process', '"env" in process'],
    ['a key in globalThis', '"Bun" in globalThis'],
    ['an instance test', 'x instanceof Proxy'],
    ['data members of process', 'process.env.X; process.argv[2]; process.platform; process.cwd()'],
    ['events of process', 'process.on("exit", f); process.once("SIGINT", g); process.nextTick(h)'],
    [
      'the streams of process',
      'process.stdout.write(s); process.stderr.write(s); process.stdin.on("data", f)',
    ],
    [
      'versions of process',
      'process.version; process.versions.node; process.hrtime(); process.uptime()',
    ],
    [
      'process in a choice of the global object',
      'const g = typeof process !== "undefined" ? process : void 0',
    ],
    ['process or an empty object', 'const p = process || {}; p.argv; p.env'],
    [
      'the global object chosen by feature detection',
      'const root = typeof globalThis !== "undefined" ? globalThis : global || self',
    ],
    [
      'a member of globalThis that is data',
      'globalThis.fetch; globalThis.navigator; globalThis.document',
    ],
    ['globalThis.process and then data', 'const e = globalThis.process?.env || {}'],
    ['a pattern that takes data out of process', 'const { env, argv } = process'],
    ['module.exports', 'module.exports = f; module.exports.x = 1'],
    ['module as a parameter', '(function (exports, module) { module.exports = 1 })'],
    ['module as a parameter of an arrow', '((exports, module) => { module.exports = 1 })'],
    ['module as the only parameter', 'function f(module) { return module.exports }'],
    ['module as a single arrow parameter', 'const f = module => module.exports'],
    ['process as a parameter', 'function f(process) { return process.env }'],
    ['global as a parameter', '(function (global, factory) { factory(global) })(this, f)'],
    ['module compared', 'require.main === module'],
    ['module compared the other way', 'module === require.main'],
    ['a key called module', 'const o = { module: "index.mjs", process: 1, global: 2 }'],
    ['a function called process', 'function process(x) { return x } process(1)'],
    ['a method called process', 'class A { process(x) { return x } }'],
    ['import.meta.url', 'import.meta.url'],
    ['import.meta.dirname and filename', 'import.meta.dirname; import.meta.filename'],
    ['a property called module', 'pkg.module; entry.process; cfg.global'],
    ['Reflect and Proxy by themselves', 'Reflect.get(obj, k); Reflect.ownKeys(o); new Proxy(t, h)'],
    ['__proto__ set', 'd.__proto__ = b'],
    ['__proto__ deleted', 'delete newObj.__proto__'],
    ['__proto__ compared', 'if (a.__proto__ === b) f()'],
    ['__proto__ as a key', 'const o = { __proto__: null }'],
    ['a method called constructor', 'class A { constructor(a) { this.a = a } }'],
    [
      'the class of this',
      'Error.captureStackTrace(this, this.constructor); new this.constructor(a)',
    ],
    ['the name and the prototype of a constructor', 'x.constructor.name; x.constructor.prototype'],
    [
      'a constructor compared',
      'a.constructor === b.constructor; typeof a.constructor === "function"',
    ],
    ['a key called Function', 'const o = { function: 1, Function: inspectFunction }'],
  ])('is not a concern: %s', (_how, text) => {
    expect(flagged(text), text).toBe(false);
  });
});

describe('the constructor of a value', () => {
  it.each([
    '(function () {}).constructor("return 1")()',
    'const F = (() => {}).constructor; F("1")',
    'foo((function () {}).constructor)',
    '(function () {}).constructor.call(null, "return 1")()',
    '(async function () {}).constructor.apply(null, ["1"])',
    '(function () {}).constructor.bind(null, "1")()',
    '(function () {}).constructor`1`',
    'Object.getPrototypeOf(async function () {}).constructor("1")',
    'x = (function () {}).constructor',
  ])('is the Function constructor in use: %s', (text) => {
    expect(flagged(text), text).toBe(true);
  });

  it.each([
    'Object.getPrototypeOf(input).constructor.name',
    'Object.getPrototypeOf(input)?.constructor?.name',
    'getProto(x).constructor === Object',
    'getProto(x).constructor !== Array ? 1 : 2',
    'f().constructor.prototype',
    'f().constructor instanceof g',
    '(a || b).constructor.name',
  ])('is only looked at: %s', (text) => {
    expect(flagged(text), text).toBe(false);
  });
});

describe('the lookup of modules', () => {
  describe.each(LOOKUP_MEMBERS.map((entry) => entry.name))('module.%s', (name) => {
    it.each([
      ['a member', `module.${name}.unshift('/x')`],
      ['a string in brackets', `module['${name}'].unshift('/x')`],
      ['a member of an alias', `const m = module; m.${name}.push('/x')`],
    ])('is found as %s', (_how, text) => {
      expect(flagged(text), text).toBe(true);
    });

    it.each([`obj.${name}.push(1)`, `const ${name} = []`, `other['${name}']`])(
      'is not found in %s',
      (text) => {
        expect(flagged(text), text).toBe(false);
      },
    );
  });

  describe.each(MODULE_ONLY_NAMES.map((entry) => entry.name))('%s', (name) => {
    it.each([
      ['a require of module', `const m = require('module'); m.${name}('./h.mjs')`],
      ['a require of node:module', `require('node:module').${name}('./h.mjs')`],
      ['an import', `import { ${name} } from 'node:module'; ${name}('./h.mjs', import.meta.url)`],
      ['an import of the default', `import m from 'module'; m.${name}('./h.mjs')`],
      ['a dynamic import', `import('node:module').then((m) => m.${name}('./h.mjs'))`],
      ['the module taken from process', `process.getBuiltinModule('module').${name}('./h')`],
    ])('is found with %s', (_how, text) => {
      expect(flagged(text), text).toBe(true);
    });

    it.each([
      `server.${name}(plugin)`,
      `registry.${name}('name', f)`,
      `import x from 'fastify'; x.${name}(plugin)`,
      `const fs = require('fs'); fs.${name}()`,
    ])('is an ordinary word without the import: %s', (text) => {
      expect(flagged(text), text).toBe(false);
    });
  });
});

describe('the modules that run text as code', () => {
  const specifiers = [...RUNS_TEXT_MODULES];
  it('is every module with and without the node: prefix', () => {
    for (const name of ['vm', 'repl', 'inspector', 'inspector/promises']) {
      expect(RUNS_TEXT_MODULES.has(name)).toBe(true);
      expect(RUNS_TEXT_MODULES.has(`node:${name}`)).toBe(true);
    }
  });

  describe.each(specifiers)('%s', (specifier) => {
    it.each([
      ['require', `const m = require('${specifier}')`],
      ['an import for effect', `import '${specifier}'`],
      ['an import of the default', `import m from '${specifier}'`],
      ['an import of names', `import { a } from '${specifier}'`],
      ['a namespace import', `import * as m from '${specifier}'`],
      ['an export from', `export * from '${specifier}'`],
      ['a dynamic import', `import('${specifier}')`],
      ['getBuiltinModule', `process.getBuiltinModule('${specifier}')`],
      ['module.require', `module.require('${specifier}')`],
    ])('is a concern through %s', (_how, text) => {
      expect(fileFlagged(text), text).toBe(true);
    });
  });

  it.each([
    'fs',
    'node:fs',
    'path',
    'crypto',
    'util',
    'events',
    'http',
    'https',
    'net',
    'os',
    'stream',
    'readline',
    'v8',
  ])('does not take %s for one', (specifier) => {
    expect(fileFlagged(`const m = require('${specifier}')`)).toBe(false);
    expect(fileFlagged(`import m from '${specifier}'`)).toBe(false);
  });
});

describe('getBuiltinModule', () => {
  it.each([
    ["process.getBuiltinModule('fs')", ['fs'], ['dynamic-code']],
    ["process.getBuiltinModule('node:vm')", ['node:vm'], ['dynamic-code']],
    ['process.getBuiltinModule(name)', [], ['computed', 'dynamic-code']],
    ["process.getBuiltinModule('f' + 's')", [], ['computed', 'dynamic-code']],
    ['const g = process.getBuiltinModule; g("vm")', [], ['computed', 'dynamic-code']],
    ['process.getBuiltinModule.call(process, "vm")', [], ['computed', 'dynamic-code']],
    ["process?.getBuiltinModule('fs')", ['fs'], ['dynamic-code']],
  ])('%s is read like a require', (text, specifiers, concerns) => {
    const scan = scanModules(text);
    expect([...scan.specifiers]).toEqual(specifiers);
    expect([...scan.concerns]).toEqual(concerns);
  });
});

describe('starting other programs', () => {
  const spawning = [...SPAWNING_MODULES];
  describe.each(spawning)('in a file that imports %s', (specifier) => {
    const head = `const cp = require('${specifier}');\n`;
    const row = (what: string, body: string): [string, string] => [what, body];
    const found: [string, string][] = [
      ...[...NODE_FLAGS].map((flag) =>
        row(`the node option ${flag}`, `cp.spawn('node', ['${flag}', code])`),
      ),
      ...NODE_FLAG_PREFIXES.map((flag) =>
        row(`the node option ${flag}`, `cp.spawn('node', ['${flag}x'])`),
      ),
      ...[...RUNNERS].map((runner) =>
        row(`the program ${runner}`, `cp.spawn('${runner}', ['pkg'])`),
      ),
      ...[...RUNNERS].map((runner) => row(`the command ${runner}`, `cp.exec('${runner} run pkg')`)),
      ...[...ENVIRONMENT_NAMES].map((name) =>
        row(`the variable ${name} as a key`, `cp.spawn('git', [], { env: { ${name}: '1' } })`),
      ),
      ...[...ENVIRONMENT_NAMES].map((name) =>
        row(`the variable ${name} as a string`, `env['${name}'] = '1'`),
      ),
      row('the Node that is running', "cp.spawn(process.execPath, ['server.js'])"),
      row('a command line for node with -e', `cp.exec('node -e "1"')`),
      row('a command line for node with --eval', `cp.exec('/usr/local/bin/node --eval 1')`),
      row('a command line for node.exe with -p', `cp.exec('C:\\\\node\\\\node.exe -p 1')`),
      row(
        'a command line for node with --require after a script',
        `cp.exec('node a.js --require x')`,
      ),
      row('a node option in a string with an escape', `cp.spawn('node', ['\\x2de', code])`),
      row('a script from the root of a disk', `cp.fork('/abs/other.js')`),
      row('a module script from the root of a disk', `cp.fork('/abs/other.mjs')`),
      row('a script from a drive', `cp.fork('C:\\\\abs\\\\other.js')`),
    ];
    it.each(found)('%s is found', (_what, body) => {
      expect(flagged(head + body), head + body).toBe(true);
    });

    it.each([
      ['git', "cp.spawn('git', ['status'])"],
      ['ls with options', "cp.execFile('ls', ['-la'])"],
      ['a command line with -p that is not node', "cp.exec('git log -p')"],
      ['a shell command', "cp.spawn('sh', ['-c', cmd])"],
      ['python with -c', "cp.spawn('python3', ['-c', 'print(1)'])"],
      ['node on a script in the tree', "cp.spawn('node', ['server.js'])"],
      ['a fork of a script in the tree', "cp.fork('./other.js')"],
      ['a worker on a script in the tree', "new Worker(new URL('./w.js', import.meta.url))"],
      ['a script from a relative path', "cp.fork('../other.js')"],
      ['a destructured exec', "const { exec: e } = cp; e('ls')"],
      [
        'strings that merely contain a runner name',
        "cp.spawn('git', ['commit', '-m', 'mentions npm here'])",
      ],
      [
        'a variable that is not a variable of the environment',
        "cp.spawn('git', [], { env: { NODE_ENV: 'x' } })",
      ],
    ])('%s is not a concern', (_what, body) => {
      expect(flagged(head + body), head + body).toBe(false);
    });
  });

  it.each([
    "args.includes('-e')",
    "const flags = ['-e', '--eval', '-p', '--require']",
    "program.option('-r, --require <x>')",
    "const runner = 'npx'; const pm = ['npm', 'pnpm', 'yarn']",
    "const where = '/abs/x.js'",
    "const env = { NODE_OPTIONS: '1' }",
    "const s = 'node -e 1'",
  ])('says nothing of the same words in a file that starts no program: %s', (text) => {
    // `NODE_OPTIONS` and `NODE_PATH` are looked at only with the imports; the other facts too.
    expect(flagged(text), text).toBe(false);
  });

  it('reads a command line as words and not as a pattern', () => {
    expect(commandRunsNodeCode('node -e 1')).toBe(true);
    expect(commandRunsNodeCode('node.exe --print 1')).toBe(true);
    expect(commandRunsNodeCode('/opt/node/bin/node --import x')).toBe(true);
    expect(commandRunsNodeCode('node server.js')).toBe(false);
    expect(commandRunsNodeCode('git log -p')).toBe(false);
    expect(commandRunsNodeCode('nodemon -e js')).toBe(false);
    expect(commandRunsNodeCode(`node ${'-x '.repeat(5000)}-e`)).toBe(false);
  });
});

describe('writing a file that Node can load', () => {
  const call = (name: string, target: string) => `fs.${name}(${target})`;
  describe.each([...WRITERS])('%s', (name) => {
    it.each([
      'x.js',
      './gen/x.mjs',
      'x.cjs',
      'x.node',
      'x.wasm',
      'package.json',
      './a/package.json',
      'X.JS',
    ])('is found writing %s', (file) => {
      expect(flagged(call(name, `'${file}', data`)), name).toBe(true);
      expect(flagged(call(name, `path.join(dir, '${file}'), data`)), name).toBe(true);
      expect(flagged(call(name, `src, '${file}'`)), name).toBe(true);
    });

    it.each(['state.json', 'x.txt', 'x.md', 'x.log', 'x.db', 'x.json5', 'js', 'x.js.bak'])(
      'does not mind writing %s',
      (file) => {
        expect(flagged(call(name, `'${file}', data`)), name).toBe(false);
      },
    );

    it('does not read a name that is made at run time, or one outside the call', () => {
      expect(flagged(call(name, 'target, data'))).toBe(false);
      expect(flagged(`fs.${name}(a, b, c, d, e, f, g, h, i, 'x.js')`)).toBe(false);
    });
  });

  it.each([
    "fs.readFileSync('x.js')",
    "require('fs').existsSync('x.js')",
    "const cp = 1; cp('x.js')",
    "rename('x.js')",
    "link('x.js')",
    "path.join('x.js')",
  ])('does not take %s for a write', (text) => {
    expect(flagged(text), text).toBe(false);
  });
});

describe('cookString', () => {
  it.each([
    ['eval', 'eval'],
    ['\\x65val', 'eval'],
    ['\\u0065val', 'eval'],
    ['\\u{65}val', 'eval'],
    ['\\u{0065}val', 'eval'],
    ['a\\nb', 'a\nb'],
    ['\\q', 'q'],
    ['a\\\nb', 'ab'],
    ['a\\\r\nb', 'ab'],
    ['\\101', 'A'],
    ['\\0', '\0'],
    ['\\\\', '\\'],
  ])('reads %j as %j', (raw, value) => {
    expect(cookString(raw)).toBe(value);
  });

  it.each(['\\x4', '\\xZZ', '\\u00', '\\u{110000}', '\\u{}', '\\u{12', '\\'])(
    'does not read %j',
    (raw) => {
      expect(cookString(raw)).toBeNull();
    },
  );
});

describe('the guide names every entry of the registry', () => {
  const guide = readFileSync(
    fileURLToPath(new URL('../../../../../docs/GUIDE.md', import.meta.url)),
    'utf8',
  );
  const names = [
    ...LOADER_NAMES.map((entry) => entry.name),
    ...PROCESS_MEMBERS.map((entry) => entry.name),
    ...GLOBAL_MEMBERS.map((entry) => entry.name),
    ...LOOKUP_MEMBERS.map((entry) => entry.name),
    ...MODULE_ONLY_NAMES.map((entry) => entry.name),
    ...RUNS_TEXT_MODULES,
    ...SPAWNING_MODULES,
    ...NODE_FLAGS,
    ...NODE_FLAG_PREFIXES,
    ...RUNNERS,
    ...ENVIRONMENT_NAMES,
    ...WRITERS,
  ];
  it.each([...new Set(names)])('mentions %s', (name) => {
    expect(guide, name).toContain(`\`${name}\``);
  });
});
