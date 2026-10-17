import { describe, expect, it } from 'vitest';
import { outsideImportsOfTree } from '../../../src/install/inspect/imports.js';
import { buildTree } from '../../../src/install/tree.js';
import { fileEntry } from '../../helpers/install-tree.js';

/**
 * The identifiers that are watched wherever they stand are read from the stream of tokens, the way Node reads it, and not
 * from lines or patterns: a comment, a line break (U+2028 and U+2029 among them), optional chaining or an automatic
 * semicolon changes nothing about which token follows which. Each row says whether the reading refuses the file ("refused")
 * or lets it by ("ordinary"); where Node runs the shape and asks for a module, the same shape is a row of the oracle test.
 *
 * Decisions this table holds, in both directions: a PROPERTY NAME that is `require` (`{ require: 1 }`, `o.require`) is not a
 * use of the function, and a shorthand (`{ require }`), a method (`require() {}`), a re-export and a pattern are; `eval` and
 * `Function` as property names are refused (`{ eval: true }` is the option that makes a Worker run text); a key, a label
 * and a parameter called `process` or `module` are not a use of the object.
 */
const flagged = (text: string): boolean =>
  outsideImportsOfTree(buildTree([fileEntry('server.js', text)], { complete: true })).concerns
    .length > 0;

type Row = readonly [name: string, text: string];

const REFUSED: readonly Row[] = [
  ['comments between process, the dot and the member', 'process /* c */ . /* d */ binding("x")'],
  ['a line break before the dot', 'process\n.binding("x")'],
  ['a line comment before the dot', 'process // c\n.binding("x")'],
  ['U+2028 before the dot', 'process\u2028.binding("x")'],
  ['U+2029 before the dot', 'process\u2029.binding("x")'],
  ['optional chaining', 'process?.binding("x")'],
  ['optional chaining with a string in brackets', 'process?.["binding"]("x")'],
  ['optional chaining with a name made at run time', 'process?.[name]'],
  ['comments inside the brackets', 'process /* c */ [ /* d */ "binding" /* e */ ]("x")'],
  [
    'a function value called on the next line with process',
    'var f = function (r) { return r }\n(process)',
  ],
  ['a comment between a name and the bracket of the call', 'f /* c */ (process)'],
  ['a call on the next line, no semicolon, with require as the argument', 'a\n(require)("x")'],
  ['no automatic semicolon before a bracket', 'x = process\n["binding"]("x")'],
  ['an automatic semicolon: require assigned, called on the next line', 'var r = require\nr("x")'],
  ['a semicolon before an array holding require', ';[require][0]("x")'],
  ['a template tagged by the name on the line before, with require in a hole', 'a\n`${require}`'],
  ['eval as a tag', 'eval`x`'],
  ['a member of process as a tag', 'process.binding`x`'],
  ['the constructor of new.target, called', 'new.target.constructor("x")'],
  ['super.eval', 'class B { m() { return super.eval("1") } }'],
  ['the constructor through super, called', 'class B { m() { return super.constructor("1") } }'],
  ['process.binding in a static block', 'class A { static { process.binding("x") } }'],
  ['eval as a class field', 'class A { eval = 1 }'],
  ['require assigned to a class field', 'class A { require = require }'],
  ['a getter called eval', 'var o = { get eval() { return 1 } }'],
  ['a setter called eval', 'var o = { set eval(v) {} }'],
  ['a shorthand property, which hands the function on', 'var o = { require }'],
  ['require as the value of a key', 'var o = { require: require }'],
  ['eval as a key, which is the option of a Worker', 'var o = { eval: true }'],
  ['a method called require, which a call is not told from', 'class A { require(x) { return x } }'],
  ['a re-export of require', 'export { require as x }'],
  ['a pattern with a default that is the function', '({ require = globalThis.require } = {})'],
  ['a pattern with a default that is require', '({ r = require } = {})'],
  ['a pattern that takes require out of module', "const { require: r } = module; r('x')"],
  ['a pattern in catch with require', 'try {} catch ({ require }) {}'],
  [
    'a pattern in catch with a default that is require',
    'try {} catch ({ r = require }) { r("x") }',
  ],
  ['with the global object', 'with (globalThis) { eval("1") }'],
  ['with process, naming a member without a dot', 'with (process) { mainModule.require("x") }'],
  ['with module', 'with (module) { require("x") }'],
  ['process in an if', 'if (f(process)) { }'],
  ['process as a condition', 'while (process) { }'],
  ['process as the subject of a switch', 'switch (process) { }'],
  ['process handed on in a for of', 'for (const x of f(process)) { }'],
  ['process in the heritage of a class', 'class A extends f(process) { }'],
  [
    'a wrapper called with the real process',
    '(function (process) { process.binding("x") })(process)',
  ],
  // Patterns that bind what they are handed: a parameter, a catch, a for head, a default, a rest, an array.
  [
    'require bound by a parameter pattern',
    "function f({ require: r }) { return r('x') } f({ require })",
  ],
  ['require bound by an arrow parameter pattern', "(({ require: r }) => r('x'))({ require })"],
  [
    'require bound by an async arrow parameter pattern',
    "(async ({ require: r }) => r('x'))({ require })",
  ],
  [
    'require bound by a parameter pattern with a default',
    "function f({ require: r } = module) { return r.call(module, 'x') }",
  ],
  [
    'require bound by a catch pattern',
    "try { throw { require } } catch ({ require: r }) { r('x') }",
  ],
  ['require bound by the head of a for of', "for (const { require: r } of [{ require }]) r('x')"],
  [
    'require assigned by the head of a for of',
    "var r; for ({ require: r } of [{ require }]) r('x')",
  ],
  ['require as the default of a parameter', "function f(r = require) { return r('x') }"],
  [
    'require as the default of a parameter, among others',
    'function f(r = require, p = process) {}',
  ],
  ['require in a rest pattern', "const { ...o } = { require }; o.require('x')"],
  ['require in an array pattern', "const [r] = [require]; r('x')"],
  ['require as the default of an array pattern', "const [r = require] = []; r('x')"],
  ['require as the default of a name in a pattern', "const { r = require } = {}; r('x')"],
  ['require bound by an assignment pattern', "var r; ({ require: r } = { require }); r('x')"],
  ['require bound next to a rest', "const { require: r, ...rest } = module; r.call(module, 'x')"],
  ['process taken out of the global object', "const { process: p } = globalThis; p.binding('x')"],
  [
    'process assigned out of the global object',
    "var p; ({ process: p } = globalThis); p.binding('x')",
  ],
  ['process taken out of global', 'const { process: p } = global; p.mainModule'],
  [
    'process taken out of the global object, one level down',
    "const { process: { binding: b } } = globalThis; b('x')",
  ],
  [
    'process taken out of an object that holds the global object',
    "const { a: { process: p } } = { a: globalThis }; p.binding('x')",
  ],
  [
    'a parameter pattern for process, handed the global object',
    "function f({ process: p }) { return p.binding('x') } f(globalThis)",
  ],
  [
    'a parameter pattern for process, whose default is the global object',
    "function f({ process: p } = globalThis) { return p.binding('x') } f()",
  ],
  [
    'a parameter pattern for process, whose default holds process',
    "function f({ process: p } = { process }) { return p.binding('x') } f()",
  ],
  ['module taken out of the global object', "const { module: m } = globalThis; m.require('x')"],
  ['process in an array pattern', "const [p] = [process]; p.binding('x')"],
  ['process as the default of a name in a pattern', "const { p = process } = {}; p.binding('x')"],
  ['eval taken out of the global object', "const { eval: e } = globalThis; e('1')"],
  ['Function taken out of the global object', "const { Function: F } = globalThis; F('1')"],
  ['the constructor taken out of a function', "const { constructor: C } = function () {}; C('1')"],
  ['the constructor taken out of an arrow', "const { constructor: C } = () => {}; C('1')"],
  ['a pattern that is the value of a chained assignment', 'var x; x = { process: p } = globalThis'],
  ['a key before a name in a pattern, among others', 'const { a, process: p } = o'],
];

const ORDINARY: readonly Row[] = [
  ['new.target', 'function F() { return new.target }'],
  ['super.method', 'class B { m() { return super.m() } }'],
  ['require in a static block', 'class A { static { require("x") } }'],
  ['require in a class field', 'class A { x = require("x") }'],
  ['require as a key', 'var o = { require: 1 }'],
  ['require as a quoted key', 'var o = { "require": 1 }'],
  ['require as a property', 'o.require'],
  ['process as a label', 'process: for (;;) { break process }'],
  ['process as a parameter', 'function f(process) { return process.env }'],
  ['module as a parameter', '(function (module) { module.exports = 1 })'],
  ['process as a key', 'var o = { process: 1 }'],
  ['module as a key', 'var o = { module: "index.mjs" }'],
  ['a comment between module and exports', 'module /* c */ . /* d */ exports = 1'],
  ['U+2028 between module and exports', 'module\u2028.exports = 1'],
  ['optional chaining on a harmless member', 'process?.env?.X'],
  ['a line break before a harmless member', 'process\n.env.X'],
  ['a string in brackets that is a harmless member', 'process["env"].X'],
  ['a template literal in brackets that is a harmless member', 'process[`env`].X'],
  // Patterns that take data, and objects written out whose keys have the names of watched identifiers.
  ['harmless members of process taken out by a pattern', 'const { env, argv } = process'],
  ['exports taken out of module by a pattern', 'const { exports } = module'],
  ['data taken out of the global object by a pattern', 'const { fetch, navigator } = globalThis'],
  ['a parameter pattern for data', 'function f({ env }) { return env } f({ env: 1 })'],
  ['a nested pattern of names', 'const { a: { b } } = obj'],
  [
    'watched names as keys of an object written out, with names as values',
    'var lit = { process: handler, Function: fn, module: info, require: loader }',
  ],
  [
    'watched names as keys of a returned object',
    'function g() { return { process: p, module: m } }',
  ],
  ['a watched name as a key of a nested object written out', 'var o = { a: { process: p } }'],
  [
    'watched names as keys with arrow functions as values',
    'var o = { process: () => 1, module: (a) => a }',
  ],
];

describe('the reading follows the stream of tokens', () => {
  it('holds a table of rows in both directions', () => {
    expect(REFUSED.length).toBeGreaterThanOrEqual(75);
    expect(ORDINARY.length).toBeGreaterThanOrEqual(24);
    expect(new Set([...REFUSED, ...ORDINARY].map(([name]) => name)).size).toBe(
      REFUSED.length + ORDINARY.length,
    );
  });

  it.each(REFUSED)('refuses: %s', (_name, text) => {
    expect(flagged(text), JSON.stringify(text)).toBe(true);
  });

  it.each(ORDINARY)('lets by: %s', (_name, text) => {
    expect(flagged(text), JSON.stringify(text)).toBe(false);
  });
});
