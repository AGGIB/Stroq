import ts from 'typescript';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scanModules } from '../../../src/install/inspect/module-specifiers.js';

/**
 * The reader of module names against a parser. Programs are put together from fragments that are the shapes a
 * lexer reads wrongly (a slash after a bracket or a keyword, a regular expression with a class, a template
 * hole, a keyword used as a property or as a name), each followed by a call of `require` that the TypeScript
 * parser finds in the syntax tree. If the program is valid JavaScript (V8 compiles it) and the parser finds a
 * `require("pN")`, the reader has to have found "pN" or flagged the file: never a program with a call and an
 * empty answer.
 *
 * The strings here are source text for the parsers to read. None of it is run.
 */
const REGEXES = [
  'a',
  '[//]',
  '[/*]',
  "'",
  '"',
  '`',
  '{',
  '}',
  '\\/',
  '[\\]/]',
  '[\'"]',
  '[/]',
  'a*',
  '${',
  '$\\{',
  '\\*',
  '[*]',
];
const FLAGS = ['', 'g', 'i'];
const KEYWORDS = [
  'of',
  'in',
  'default',
  'return',
  'typeof',
  'new',
  'delete',
  'void',
  'case',
  'do',
  'else',
  'throw',
  'yield',
  'await',
  'instanceof',
];
const NAMES = ['of', 'yield', 'await', 'async', 'let', 'static', 'get', 'set'];

/** A small generator with a seed, so that a failure is the same on every run. */
function generator(seed: number) {
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  return { next, pick };
}

type Fragment = (pick: <T>(list: readonly T[]) => T) => string;
const regex = (pick: <T>(list: readonly T[]) => T): string => `/${pick(REGEXES)}/${pick(FLAGS)}`;

const FRAGMENTS: readonly Fragment[] = [
  (p) => `if (a) ${regex(p)}.test(b);`,
  (p) => `while (a) ${regex(p)}.test(b);`,
  () => 'x = (a) / c;',
  () => 'x = (a) / c / d;',
  () => "x = b[0] / c; y = '/' ;",
  () => 'x = b++ / c / d;',
  (p) => `x = a + ${regex(p)}.source;`,
  (p) => `x = a - ${regex(p)}.source;`,
  () => 'x = a\n/c/g.exec(z);',
  (p) => `{}\n${regex(p)}.test(a);`,
  (p) => `function f(){}\n${regex(p)}.test(a);`,
  () => 'x = function(){} / 2;',
  (p) => `x = \`\${${regex(p)}.test(a)}\`;`,
  () => 'x = `a${b}c${`${d}`}`;',
  () => 'x = `}\'"`;',
  () => 'x = \'"\' + "\'" + \'\\\'\' + "\\"";',
  () => "x = 'a\\\nb';",
  () => '// comment \' " ` /* \n',
  () => '/* c \' " ` \n */',
  () => '/* c */ --> not html\n',
  () => 'x = a <!-- b\n',
  (p) => `x = o.${p(KEYWORDS)} / 2; y = z / 3;`,
  (p) => `var ${p(NAMES)} = 4; x = ${p(NAMES)} / 2; y = z / 3;`,
  (p) => `x = ${p(['typeof', 'void', 'delete'])} ${regex(p)};`,
  (p) => `x = a ? ${regex(p)} : ${regex(p)};`,
  (p) => `f(${regex(p)}, ${regex(p)});`,
  (p) => `x = [${regex(p)}, ${regex(p)}];`,
  (p) => `x = {a: ${regex(p)}};`,
  (p) => `x = () => ${regex(p)}.test(a);`,
  () => 'x = a => a / 2;',
  () => 'o = {import: 1, require: function(){}, export: 2};',
  () => 'o.import(1); o.require("m");',
  () => 'x = y.constructor / 2;',
  (p) => `label: ${regex(p)}.test(a);`,
  () => 'x = a /* c */ / b / c;',
  () => 'x = 1 / 2 / 3; y = 4e3 / 5;',
  () => 'x = 0x1f / 2; y = 1.5.toFixed() / 2;',
  () => "x = \"str\" / 2 / 3; y = 'a' / 'b';",
  () => 'x = this / 2 / 3; y = null / 2 / 3;',
  () => 'x = a.b\n/ c / d;',
  (p) => `for (x of ${regex(p)}.source) {}`,
  (p) => `for (var i in ${regex(p)}) {}`,
  (p) => `switch(a){ case ${regex(p)}: break; default: ${regex(p)}.test(a); }`,
  (p) => `do ${regex(p)}.test(a); while(0);`,
  (p) => `if (a) ; else ${regex(p)}.test(b);`,
  (p) => `if (0) throw ${regex(p)};`,
  () => 'class A { static { x = a / b / c; } }',
  (p) => `x = ${regex(p)}\n/ 2;`,
  () => "x = ' ' / 2;",
  () => 'var \\u0061b = 1;',
  (p) => `x = (function(){ return ${regex(p)}.test(a); })();`,
  (p) => `x = a ?? ${regex(p)};`,
  () => 'x = a?.b / 2 / c;',
  () => 'x = a ** 2 / 3 / 4;',
  (p) => `x = ~${regex(p)}.test(a);`,
  (p) => `x = !${regex(p)}.test(a);`,
  (p) => `x = a, ${regex(p)};`,
  (p) => `x = (1, ${regex(p)});`,
  () => 'x = a /= 2 / 3;',
  (p) => `x = a[${regex(p)}.source];`,
  () => 'x = {} / 1 / 2;',
  (p) => `x = (${regex(p)}) / 2 / 3;`,
  () => 'x = a ? b : c / d / e;',
  () => 'x = `${a}` / 2 / 3;',
  () => 'x = `${ {a:1}.a }`;',
  () => "x = `${ `${ '}' }` }`;",
  (p) => `async function g(){ await ${regex(p)}.test(a); }`,
  (p) => `function* h(){ yield ${regex(p)}; yield\n/c/g; }`,
  () => 'x = a\n.b\n/ 2;',
  () => 'x = a\n?.b\n/ 2;',
  () => 'x = class {} / 2;',
  () => 'x = class A { m() {} } / 2;',
  (p) => `if (a) { b } else { c }\n${regex(p)}.test(d);`,
  (p) => `try { } catch (e) { }\n${regex(p)}.test(d);`,
  (p) => `x = { m() {} }.m / 2;\n${regex(p)}.test(d);`,
  (p) => `x = [function(){}, ${regex(p)}];`,
  (p) => `x = a ? function(){} : ${regex(p)};`,
  (p) => `new ${p(['A', 'B'])}(${regex(p)}); `,
  () => 'x = typeof a / 2;',
  () => 'x = void 0 / 2;',
];

/** The `require("...")` calls with a string argument that the parser finds, or null when the text is not a program. */
function required(code: string): string[] | null {
  try {
    new vm.Script(`(function(require){${code}\n})`);
  } catch {
    return null;
  }
  const file = ts.createSourceFile('x.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (((file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0)
    return null;
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0] as ts.Node)
    )
      found.push((node.arguments[0] as ts.StringLiteral).text);
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

function program(next: () => number, pick: <T>(list: readonly T[]) => T): string {
  let count = 0;
  const parts: string[] = [];
  const pieces = 2 + Math.floor(next() * 5);
  for (let i = 0; i < pieces; i += 1) {
    parts.push(pick(FRAGMENTS)(pick));
    if (next() < 0.5) parts.push(`require("p${count++}");`);
    parts.push(pick(['\n', ' ', ';\n']));
  }
  return count === 0 ? '' : parts.join('');
}

describe('the reader of module names against the TypeScript parser', () => {
  it('finds every require the parser finds in a valid program, or flags the file', () => {
    const { next, pick } = generator(7);
    const escapes: string[] = [];
    let checked = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const code = program(next, pick);
      const truth = code === '' ? null : required(code);
      if (truth === null || truth.length === 0) continue;
      checked += 1;
      const scan = scanModules(code);
      if (scan.concerns.length === 0 && truth.some((name) => !scan.specifiers.includes(name)))
        escapes.push(code);
    }

    expect(escapes.slice(0, 5)).toEqual([]);
    // The check is only worth something if a good share of the programs were valid and had a call in them.
    expect(checked).toBeGreaterThan(3_000);
  });

  it('does not flag the plain programs it was built from for no reason', () => {
    // Fragments that are not ambiguous must be read through, so that the check above is not met by flagging all.
    const { next, pick } = generator(11);
    let read = 0;
    let flagged = 0;
    for (let i = 0; i < 5_000; i += 1) {
      const code = program(next, pick);
      const truth = code === '' ? null : required(code);
      if (truth === null || truth.length === 0) continue;
      read += 1;
      if (scanModules(code).concerns.length > 0) flagged += 1;
    }

    expect(flagged / read).toBeLessThan(0.25);
  });
});
