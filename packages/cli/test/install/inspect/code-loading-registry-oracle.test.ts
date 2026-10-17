import { describe, expect, it } from 'vitest';
import {
  GLOBAL_MEMBERS,
  LOADER_NAMES,
  PROCESS_MEMBERS,
} from '../../../src/install/inspect/code-loading-registry.js';
import { scanModules } from '../../../src/install/inspect/module-specifiers.js';
import { v8IdentifierParts, v8Reads, v8Sweep, type Item } from '../../helpers/v8-reads.js';

/**
 * The registry of what runs text as code or loads code by name (`code-loading-registry.ts`) against V8, which is what
 * Node reads text with. `code-loading-registry.test.ts` writes every entry in the spellings the reading was built for;
 * this file asks V8 what each spelling means. A snippet is run in a context where every name is a stub that records
 * that it was read (`test/helpers/v8-reads.mjs`), in the script goal and in the module goal, so the question is not
 * what the text looks like but which names Node reads when it runs it. The rule that the tables hold:
 *
 *   - where V8 accepts a snippet and reads a name of the registry, the reading flags the snippet, whatever spelling of
 *     the name it is (an identifier or a string, with unicode, hex, braced, octal or line-continuation escapes, a
 *     template, optional chaining, comments and breaks between the tokens, a pattern, a parameter, a catch);
 *   - a name is matched against the TOKEN, after the escapes are decoded: a word that merely contains it, or has a
 *     joiner (U+200C, U+200D) or any other character V8 reads as part of an identifier next to it, is another name;
 *   - a string, a comment, a regular expression and the text of a template are not a use, and the hole of a template
 *     (`${ ... }`) is code.
 */
type Receiver = 'x' | 'process';

interface Name {
  readonly name: string;
  readonly receiver: Receiver;
}

const NAMES: readonly Name[] = [
  ...LOADER_NAMES.map(({ name }) => ({ name, receiver: 'x' as const })),
  ...GLOBAL_MEMBERS.map(({ name }) => ({ name, receiver: 'x' as const })),
  ...PROCESS_MEMBERS.map(({ name }) => ({ name, receiver: 'process' as const })),
];

const hex = (code: number, width: number): string => code.toString(16).padStart(width, '0');
const esc4 = (char: string): string => `\\u${hex(char.codePointAt(0)!, 4)}`;
const braced = (char: string, width = 0): string => `\\u{${hex(char.codePointAt(0)!, width)}}`;
const rest = (name: string): string => name.slice(1);
const identity = (name: string): string =>
  [...name]
    .map((char) => (/[a-zA-Z]/.test(char) && !'bfnrtvux'.includes(char) ? `\\${char}` : char))
    .join('');

/** The ways to write the name as an identifier (after a dot, as a key, as a variable): escapes decode to the same name. */
const dots = (name: string): readonly string[] => [
  name,
  `${esc4(name[0]!)}${rest(name)}`,
  `${braced(name[0]!)}${rest(name)}`,
  `${braced(name[0]!, 9)}${rest(name)}`,
  `${name.slice(0, 2)}${esc4(name[2] ?? 'a')}${name.slice(3)}`,
  `${name.slice(0, -1)}${esc4(name.at(-1)!)}`,
  [...name].map((char) => esc4(char)).join(''),
  [...name].map((char) => braced(char)).join(''),
  [...name].map((char, i) => (i % 2 === 0 ? esc4(char) : braced(char))).join(''),
];

/** The ways to write it inside a string or a template: the escapes of a string, a line continuation, legacy octal. */
const strings = (name: string): readonly string[] => [
  name,
  `\\x${hex(name.charCodeAt(0), 2)}${rest(name)}`,
  [...name].map((char) => `\\x${hex(char.charCodeAt(0), 2)}`).join(''),
  `${esc4(name[0]!)}${rest(name)}`,
  `${braced(name[0]!)}${rest(name)}`,
  `${braced(name[0]!, 9)}${rest(name)}`,
  `\\${name.charCodeAt(0).toString(8)}${rest(name)}`,
  `${name[0]}\\\n${rest(name)}`,
  `${name[0]}\\\r\n${rest(name)}`,
  `${name[0]}\\\u2028${rest(name)}`,
  `${name[0]}\\\u2029${rest(name)}`,
  identity(name),
  [...name]
    .map((char, i) =>
      i % 3 === 0 ? esc4(char) : i % 3 === 1 ? `\\x${hex(char.charCodeAt(0), 2)}` : braced(char),
    )
    .join(''),
];

type Shape = (m: { dot: string; str: string }, r: Receiver) => string;

/** A shape takes the name as an identifier (`dot`) or as the body of a string (`str`), on a receiver. */
const MEMBER_SHAPES: readonly {
  readonly how: string;
  readonly dot?: true;
  readonly make: Shape;
}[] = [
  { how: 'a member called', dot: true, make: ({ dot }, r) => `${r}.${dot}(1)` },
  { how: 'an optional member called', dot: true, make: ({ dot }, r) => `${r}?.${dot}(1)` },
  {
    how: 'comments around the dot',
    dot: true,
    make: ({ dot }, r) => `${r} /*c*/ . /*d*/ ${dot}(1)`,
  },
  { how: 'breaks around the dot', dot: true, make: ({ dot }, r) => `${r}\n.\n${dot}(1)` },
  {
    how: 'a line separator before the dot',
    dot: true,
    make: ({ dot }, r) => `${r}\u2028.${dot}(1)`,
  },
  { how: 'a member of a member', dot: true, make: ({ dot }, r) => `${r}.y.${dot}(1)` },
  { how: 'a member read', dot: true, make: ({ dot }, r) => `var v = ${r}.${dot}` },
  {
    how: 'a member assigned to a variable and called',
    dot: true,
    make: ({ dot }, r) => `var v = ${r}.${dot}; v(1)`,
  },
  {
    how: 'a member called with call',
    dot: true,
    make: ({ dot }, r) => `${r}.${dot}.call(${r}, 1)`,
  },
  { how: 'a member tagged', dot: true, make: ({ dot }, r) => `${r}.${dot}\`1\`` },
  { how: 'a member with new', dot: true, make: ({ dot }, r) => `new ${r}.${dot}(1)` },
  { how: 'a string in brackets', make: ({ str }, r) => `${r}['${str}'](1)` },
  { how: 'a double-quoted string in brackets', make: ({ str }, r) => `${r}["${str}"](1)` },
  { how: 'a template in brackets', make: ({ str }, r) => `${r}[\`${str}\`](1)` },
  { how: 'an optional string in brackets', make: ({ str }, r) => `${r}?.['${str}'](1)` },
  { how: 'an optional string in brackets, deeper', make: ({ str }, r) => `${r}.y?.['${str}'](1)` },
  {
    how: 'comments in the brackets',
    make: ({ str }, r) => `${r} /*c*/ [ /*d*/ '${str}' /*e*/ ](1)`,
  },
  { how: 'a break before the bracket', make: ({ str }, r) => `${r}\n['${str}'](1)` },
  { how: 'a bracket on a parenthesis', make: ({ str }, r) => `(${r})['${str}'](1)` },
  { how: 'a bracket on a call', make: ({ str }, r) => `f()['${str}'](1)` },
  { how: 'a bracket on an index', make: ({ str }, r) => `${r}[0]['${str}'](1)` },
  { how: 'a bracket after a bracket', make: ({ str }, r) => `${r}['a']['${str}'](1)` },
  { how: 'a string in brackets with new', make: ({ str }, r) => `new ${r}['${str}'](1)` },
  { how: 'a string in brackets read', make: ({ str }, r) => `var v = ${r}['${str}']` },
  { how: 'a string in brackets tagged', make: ({ str }, r) => `${r}['${str}']\`1\`` },
  {
    how: 'a name taken out by a pattern',
    dot: true,
    make: ({ dot }, r) => `const { ${dot} } = ${r}`,
  },
  {
    how: 'a name taken out and renamed',
    dot: true,
    make: ({ dot }, r) => `const { ${dot}: v } = ${r}`,
  },
  {
    how: 'a name assigned out by a pattern',
    dot: true,
    make: ({ dot }, r) => `var v; ({ ${dot}: v } = ${r})`,
  },
  {
    how: 'a string key taken out by a pattern',
    make: ({ str }, r) => `const { '${str}': v } = ${r}`,
  },
  {
    how: 'a computed key taken out by a pattern',
    make: ({ str }, r) => `const { ['${str}']: v } = ${r}`,
  },
  {
    how: 'a name taken out by a parameter',
    dot: true,
    make: ({ dot }, r) => `function f({ ${dot}: v }) {} f(${r})`,
  },
  {
    how: 'a name taken out by an arrow parameter',
    dot: true,
    make: ({ dot }, r) => `(({ ${dot}: v }) => v)(${r})`,
  },
  {
    how: 'a name taken out by a for head',
    dot: true,
    make: ({ dot }, r) => `for (const { ${dot}: v } of [${r}]) v`,
  },
  {
    how: 'a name taken out by a catch',
    dot: true,
    make: ({ dot }, r) => `try { throw ${r} } catch ({ ${dot}: v }) {}`,
  },
  {
    how: 'a name that is a default in a pattern',
    dot: true,
    make: ({ dot }, r) => `const { v = ${r}.${dot} } = {}`,
  },
];

/** The ways a global name (`eval`, `Function`) is reached without a receiver, or from the global object. */
const GLOBAL_SHAPES: readonly { readonly how: string; readonly make: (dot: string) => string }[] = [
  { how: 'a free call', make: (n) => `${n}('1')` },
  { how: 'a comma expression', make: (n) => `(0, ${n})('1')` },
  { how: 'an optional call', make: (n) => `${n}?.('1')` },
  { how: 'a tagged template', make: (n) => `${n}\`1\`` },
  { how: 'a new', make: (n) => `new ${n}('1')` },
  { how: 'a value handed on', make: (n) => `f(${n})` },
  { how: 'a variable set to it', make: (n) => `var v = ${n}; v('1')` },
  { how: 'an alias taken out by a pattern', make: (n) => `const { ${n}: v } = x; v('1')` },
  { how: 'a member of the global object', make: (n) => `globalThis.${n}('1')` },
  { how: 'a member of global', make: (n) => `global.${n}('1')` },
  { how: 'an optional member of the global object', make: (n) => `globalThis?.${n}('1')` },
];

const items: (Item & { readonly name: string; readonly how: string })[] = [];
const goals = ['script', 'module'] as const;
const addItem = (name: string, how: string, code: string): void => {
  for (const goal of goals) items.push({ code, goal, name, how });
};

for (const { name, receiver } of NAMES) {
  const spellDots = dots(name);
  const spellStrings = strings(name);
  for (const shape of MEMBER_SHAPES) {
    const spellings = shape.dot === true ? spellDots : spellStrings;
    for (const [index, spelling] of spellings.entries())
      addItem(
        name,
        `${shape.how}, spelling ${index}`,
        shape.make({ dot: spelling, str: spelling }, receiver),
      );
  }
}
for (const { name } of GLOBAL_MEMBERS) {
  for (const shape of GLOBAL_SHAPES)
    for (const [index, spelling] of dots(name).entries())
      addItem(name, `${shape.how}, spelling ${index}`, shape.make(spelling));
}
// The same names through the process object, however it is reached.
for (const { name } of PROCESS_MEMBERS) {
  for (const [index, spelling] of dots(name).entries()) {
    addItem(name, `through globalThis, spelling ${index}`, `globalThis.process.${spelling}(1)`);
    addItem(name, `through global, spelling ${index}`, `global.process.${spelling}(1)`);
    addItem(name, `through an optional chain, spelling ${index}`, `process?.${spelling}?.(1)`);
    addItem(name, `through with, spelling ${index}`, `with (process) { ${spelling}(1) }`);
  }
}
// The constructor: only where it is used (called, tagged), since reading it is not a use.
const CONSTRUCTOR_SHAPES: readonly {
  readonly how: string;
  readonly dot?: true;
  readonly make: Shape;
}[] = [
  { how: 'a call', dot: true, make: ({ dot }) => `f.${dot}('1')` },
  { how: 'an optional call', dot: true, make: ({ dot }) => `f?.${dot}('1')` },
  { how: 'an optional invocation', dot: true, make: ({ dot }) => `f.${dot}?.('1')` },
  { how: 'a call on a call', dot: true, make: ({ dot }) => `f().${dot}('1')` },
  { how: 'a tagged call', dot: true, make: ({ dot }) => `f.${dot}\`1\`` },
  { how: 'a tagged call with a hole', dot: true, make: ({ dot }) => `f.${dot}\`a\${b}c\`` },
  { how: 'a string in brackets, called', make: ({ str }) => `f['${str}']('1')` },
  { how: 'a template in brackets, called', make: ({ str }) => `f[\`${str}\`]('1')` },
  { how: 'an optional string in brackets, called', make: ({ str }) => `f?.['${str}']('1')` },
  { how: 'a string in brackets, optionally called', make: ({ str }) => `f['${str}']?.('1')` },
  {
    how: 'an optional string in brackets, optionally called',
    make: ({ str }) => `f?.['${str}']?.('1')`,
  },
  { how: 'a string in brackets on a call', make: ({ str }) => `f()['${str}']('1')` },
  { how: 'a string in brackets, tagged', make: ({ str }) => `f['${str}']\`1\`` },
  {
    how: 'taken out by a pattern',
    dot: true,
    make: ({ dot }) => `const { ${dot}: C } = function () {}; C('1')`,
  },
  {
    how: 'a string key taken out by a pattern',
    make: ({ str }) => `const { '${str}': C } = function () {}; C('1')`,
  },
  {
    how: 'a computed key taken out by a pattern',
    make: ({ str }) => `const { ['${str}']: C } = function () {}; C('1')`,
  },
  {
    how: 'taken out by a nested pattern',
    dot: true,
    make: ({ dot }) => `const { y: { ${dot}: C } } = x; C('1')`,
  },
  {
    how: 'a string key taken out by a nested pattern',
    make: ({ str }) => `const { y: { '${str}': C } } = x; C('1')`,
  },
  {
    how: 'a computed key taken out by a nested pattern',
    make: ({ str }) => `const { y: { ['${str}']: C } } = x; C('1')`,
  },
];
for (const shape of CONSTRUCTOR_SHAPES) {
  const spellings = shape.dot === true ? dots('constructor') : strings('constructor');
  for (const [index, spelling] of spellings.entries())
    addItem(
      'constructor',
      `${shape.how}, spelling ${index}`,
      shape.make({ dot: spelling, str: spelling }, 'x'),
    );
}

const flagged = (code: string): boolean => scanModules(code).concerns.length > 0;

/** Many failures of one kind say it once: the kind, how many, and the first few. */
function summarize(
  problems: readonly { readonly kind: string; readonly line: string }[],
): string[] {
  const kinds = new Map<string, string[]>();
  for (const { kind, line } of problems) kinds.set(kind, [...(kinds.get(kind) ?? []), line]);
  return [...kinds].map(
    ([kind, lines]) => `${kind} (${lines.length}): ${lines.slice(0, 3).join(' ;; ')}`,
  );
}

describe('every spelling of the registry that V8 reads as the name is read by the reading', () => {
  it('flags each snippet in which V8 reads a name of the registry, in both goals', async () => {
    const answers = await v8Reads(items, 150_000);
    const problems: { kind: string; line: string }[] = [];
    const accepted = { script: 0, module: 0 };
    let read = 0;
    for (const [index, item] of items.entries()) {
      const answer = answers[index]!;
      if (!answer.accepted) continue;
      accepted[item.goal] += 1;
      if (!answer.reads.includes(item.name)) continue;
      read += 1;
      if (!flagged(item.code))
        problems.push({
          kind: `${item.how.replace(/, spelling \d+$/, '')} | ${item.goal}`,
          line: `${item.name} ${JSON.stringify(item.code)}`,
        });
    }

    expect(summarize(problems)).toEqual([]);
    // The table is not vacuous: V8 accepted most of it, and read the name in most of what it accepted.
    expect(accepted.script).toBeGreaterThan(items.length / 2 / 2);
    expect(accepted.module).toBeGreaterThan(items.length / 2 / 3);
    expect(read).toBeGreaterThan(2000);
  }, 180_000);

  it('reads every spelling of the name as the name in V8, so that the table says what it means', async () => {
    const own = items.filter((item) => item.how.startsWith('a member called'));
    const answers = await v8Reads(own);
    const wrong = own.filter((item, index) => {
      const answer = answers[index]!;
      return answer.accepted && !answer.reads.includes(item.name);
    });

    expect(
      wrong.map((item) => `${item.name} | ${item.how} | ${JSON.stringify(item.code)}`),
    ).toEqual([]);
  }, 60_000);
});

/** A text that holds the word without using it, or uses it without the plain word. `expectRead` is what V8 says. */
interface Row {
  readonly how: string;
  readonly make: (name: string, receiver: Receiver) => string;
  readonly read: boolean;
}

const swapCase = (char: string): string =>
  char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();

const TOKEN_ROWS: readonly Row[] = [
  { how: 'a string that holds the call', make: (n, r) => `var s = '${r}.${n}(1)'`, read: false },
  { how: 'a double-quoted string', make: (n, r) => `var s = "${r}.${n}(1)"`, read: false },
  { how: 'a string of the bare word', make: (n) => `var s = '${n}'`, read: false },
  { how: 'a string in a list', make: (n) => `var l = ['${n}', 'other']`, read: false },
  { how: 'a string key', make: (n) => `var o = { '${n}': 1 }`, read: false },
  { how: 'a line comment', make: (n, r) => `// ${r}.${n}(1)\nvar a = 1`, read: false },
  { how: 'a block comment', make: (n, r) => `/* ${r}.${n}(1) */ var a = 1`, read: false },
  {
    how: 'a block comment over lines',
    make: (n, r) => `/*\n${r}.${n}(1)\n*/ var a = 1`,
    read: false,
  },
  { how: 'a regular expression', make: (n) => `var re = /${n}/g`, read: false },
  {
    how: 'a regular expression with the call',
    make: (n, r) => `/${r}\\.${n}\\(/.test(a)`,
    read: false,
  },
  { how: 'the text of a template', make: (n, r) => `var t = \`${r}.${n}(1)\``, read: false },
  { how: 'the text of a template, bare', make: (n) => `var t = \`${n}\``, read: false },
  {
    how: 'an escaped hole in a template',
    make: (n, r) => `var t = \`\\\${${r}.${n}(1)}\``,
    read: false,
  },
  { how: 'a string in a hole', make: (n) => `var t = \`\${'${n}'}\``, read: false },
  { how: 'a comment in a hole', make: (n, r) => `var t = \`\${/* ${r}.${n} */ 1}\``, read: false },
  { how: 'the hole of a template', make: (n, r) => `var t = \`\${${r}.${n}(1)}\``, read: true },
  {
    how: 'the hole of a template after text',
    make: (n, r) => `var t = \`a b \${${r}.${n}(1)} c\``,
    read: true,
  },
  {
    how: 'a hole in a hole',
    make: (n, r) => `var t = \`a \${\`b \${${r}.${n}(1)}\`}\``,
    read: true,
  },
  {
    how: 'the second hole of a template',
    make: (n, r) => `var t = \`\${1}\${${r}.${n}(1)}\``,
    read: true,
  },
  { how: 'a hole in a tagged template', make: (n, r) => `tag\`\${${r}.${n}(1)}\``, read: true },
  {
    how: 'a hole after a string in the hole',
    make: (n, r) => `var t = \`\${'x'}\${${r}.${n}}\``,
    read: true,
  },
  { how: 'a letter more before', make: (n, r) => `${r}.x${n}(1)`, read: false },
  { how: 'a letter more after', make: (n, r) => `${r}.${n}x(1)`, read: false },
  { how: 'a dollar sign before', make: (n, r) => `${r}.$${n}(1)`, read: false },
  { how: 'a dollar sign after', make: (n, r) => `${r}.${n}$(1)`, read: false },
  { how: 'an underscore before', make: (n, r) => `${r}._${n}(1)`, read: false },
  { how: 'a digit after', make: (n, r) => `${r}.${n}2(1)`, read: false },
  { how: 'a zero width joiner after', make: (n, r) => `${r}.${n}\u200d(1)`, read: false },
  { how: 'a zero width non-joiner after', make: (n, r) => `${r}.${n}\u200c(1)`, read: false },
  {
    how: 'a zero width joiner inside',
    make: (n, r) => `${r}.${n.slice(0, 2)}\u200d${n.slice(2)}(1)`,
    read: false,
  },
  {
    how: 'a zero width non-joiner inside',
    make: (n, r) => `${r}.${n.slice(0, 2)}\u200c${n.slice(2)}(1)`,
    read: false,
  },
  {
    how: 'a joiner written as an escape inside',
    make: (n, r) => `${r}.${n.slice(0, 2)}\\u200d${n.slice(2)}(1)`,
    read: false,
  },
  { how: 'a middle dot after', make: (n, r) => `${r}.${n}\u00b7(1)`, read: false },
  { how: 'a combining mark after', make: (n, r) => `${r}.${n}\u0301(1)`, read: false },
  { how: 'a spacing mark after', make: (n, r) => `${r}.${n}\u0903(1)`, read: false },
  { how: 'a connector punctuation after', make: (n, r) => `${r}.${n}\u203f(1)`, read: false },
  { how: 'a letter of another script before', make: (n, r) => `${r}.\u0430${n}(1)`, read: false },
  {
    how: 'a letter of another script instead of the first',
    make: (n, r) => `${r}.\u0430${n.slice(1)}(1)`,
    read: false,
  },
  { how: 'a mathematical digit after', make: (n, r) => `${r}.${n}\u{1d7d8}(1)`, read: false },
  { how: 'a letter outside the plane after', make: (n, r) => `${r}.${n}\u{10000}(1)`, read: false },
  { how: 'the name in another case', make: (n, r) => `${r}.${n.toUpperCase()}(1)`, read: false },
  {
    how: 'the name with the first letter in another case',
    make: (n, r) => `${r}.${swapCase(n[0]!)}${n.slice(1)}(1)`,
    read: false,
  },
  { how: 'the plain call', make: (n, r) => `${r}.${n}(1)`, read: true },
];

describe('the name is matched against the token and not against the text', () => {
  const rows = NAMES.filter(({ name }) =>
    // The members of process are matched against a list of the harmless ones (any other member is a concern, so a
    // word that merely contains `binding` is one as well): they have a table of their own below.
    ['createRequire', 'registerHooks', 'eval', 'Function', 'runMain', 'dlopen'].includes(name),
  ).flatMap(({ name, receiver }) =>
    TOKEN_ROWS.map((row) => ({ name, receiver, row, code: row.make(name, receiver) })),
  );

  it('flags a snippet exactly when V8 reads the name, for each row of the table', async () => {
    const answers = await v8Reads(
      rows.flatMap(({ code }) => goals.map((goal) => ({ code, goal }))),
    );
    const problems: { kind: string; line: string }[] = [];
    let accepted = 0;
    for (const [index, { name, row, code }] of rows.entries()) {
      for (const [g, goal] of goals.entries()) {
        const answer = answers[index * goals.length + g]!;
        if (!answer.accepted) continue;
        accepted += 1;
        const reads = answer.reads.includes(name);
        const here = `${name} | ${row.how} | ${goal} | ${JSON.stringify(code)}`;
        // The table says what V8 does, and the reading agrees with it.
        if (reads !== row.read)
          problems.push({
            kind: `V8 ${reads ? 'reads' : 'does not read'}: ${row.how}`,
            line: here,
          });
        if (flagged(code) !== row.read)
          problems.push({
            kind: `the reading ${flagged(code) ? 'flags' : 'does not flag'}: ${row.how}`,
            line: here,
          });
      }
    }

    expect(summarize(problems)).toEqual([]);
    expect(accepted).toBeGreaterThan(rows.length);
  }, 120_000);
});

// These independent character classes are test inputs, not the lexer's tables. V8 verifies their meaning before the
// scanner is compared with it. The ordinary suite keeps every ECMAScript space and line terminator, plus members and
// non-members of each relevant Unicode identifier class. The multi-million compilation sweep is a separate opt-in.
const SPACE_POINTS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
  0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
] as const;
const NOT_SPACE_POINTS = [
  0x00, 0x30, 0x41, 0x85, 0x180e, 0x200b, 0x2060, 0x10000, 0x1f600,
] as const;
// Dollar/underscore, ASCII letters, Latin/Cyrillic/CJK letters and letters outside the BMP.
const IDENTIFIER_START_POINTS = [
  0x24, 0x5f, 0x41, 0x7a, 0xaa, 0xb5, 0x430, 0x4e2d, 0x10000, 0x1d400,
] as const;
// Digits, combining/spacing marks, connector punctuation and the two joiners only continue a name.
const IDENTIFIER_CONTINUE_ONLY_POINTS = [
  0x30, 0x39, 0xb7, 0x300, 0x903, 0x200c, 0x200d, 0x203f, 0x1d7d8,
] as const;
const NOT_IDENTIFIER_POINTS = [
  0x00, 0x09, 0x20, 0x2d, 0x2e, 0x2f, 0x3a, 0x85, 0x180e, 0x200b, 0x2028, 0xfeff, 0x1f600,
] as const;
const EXHAUSTIVE = process.env['STROQ_EXHAUSTIVE_V8_ORACLE'] === '1';
const exhaustiveIt = EXHAUSTIVE ? it : it.skip;
const sorted = (points: readonly number[]) => [...points].sort((a, b) => a - b);

describe('the V8 oracle is isolated and has a subprocess deadline', () => {
  it('kills an oracle that exceeds its deadline, before rejecting its result', async () => {
    await expect(v8Reads([{ code: 'while (true) {}', goal: 'script' }], 1)).rejects.toThrow(
      /timed out .* and was killed/,
    );
  });
});

describe('what stands between the tokens is whatever V8 reads as space, and nothing else', () => {
  // U+0001 stands where the character goes. Each shape names the registry entry it reads, so that V8 running it is a use.
  const SHAPES = {
    createRequire: [
      { text: 'x.createRequire\u0001(1)', needs: ['x'] },
      { text: 'x.\u0001createRequire(1)', needs: ['x'] },
      { text: 'x\u0001.createRequire(1)', needs: ['x'] },
      { text: '\u0001createRequire(1)', needs: [] },
      { text: 'createRequire\u0001(1)', needs: [] },
      { text: 'x?.\u0001createRequire(1)', needs: ['x'] },
      { text: "x[\u0001'createRequire'](1)", needs: ['x'] },
      { text: "x['createRequire'\u0001](1)", needs: ['x'] },
      { text: 'const {\u0001createRequire } = x', needs: ['x'] },
      { text: 'const { createRequire\u0001} = x', needs: ['x'] },
    ],
    mainModule: [
      { text: 'process\u0001.mainModule.require("zzpkg")', needs: ['process'] },
      { text: 'process.\u0001mainModule.require("zzpkg")', needs: ['process'] },
      { text: 'process.mainModule\u0001.require("zzpkg")', needs: ['process', 'require'] },
      { text: 'process.mainModule.\u0001require("zzpkg")', needs: ['process', 'require'] },
      { text: 'process.mainModule.require\u0001("zzpkg")', needs: ['process', 'require'] },
    ],
    eval: [
      { text: '\u0001eval("1")', needs: [] },
      { text: 'eval\u0001("1")', needs: [] },
      { text: 'globalThis\u0001.eval("1")', needs: ['globalThis'] },
      { text: 'globalThis.\u0001eval("1")', needs: ['globalThis'] },
      { text: 'globalThis.eval\u0001("1")', needs: ['globalThis'] },
    ],
  } as const;

  function checkSpaces(
    shapes: readonly { readonly text: string; readonly needs: readonly string[] }[],
    ran: readonly { readonly shape: number; readonly cp: number }[],
  ): void {
    const missed = ran
      .filter(
        ({ shape, cp }) =>
          !flagged(shapes[shape]!.text.replaceAll('\u0001', String.fromCodePoint(cp))),
      )
      .map(
        ({ shape, cp }) => `${JSON.stringify(shapes[shape]?.text)} U+${hex(cp, 4).toUpperCase()}`,
      );
    expect(missed).toEqual([]);
    // Check every shape separately: a declaration that stops running after its first character cannot hide behind
    // the successful call shapes. This also covers both positions in the repeated const-pattern declaration.
    for (const [shape, { text }] of shapes.entries()) {
      const chars = new Set(ran.filter((one) => one.shape === shape).map(({ cp }) => cp));
      for (const cp of SPACE_POINTS)
        expect(chars.has(cp), `${JSON.stringify(text)} U+${hex(cp, 4)}`).toBe(true);
      for (const cp of NOT_SPACE_POINTS)
        expect(chars.has(cp), `${JSON.stringify(text)} U+${hex(cp, 4)} is not space`).toBe(false);
    }
  }

  it.each(Object.entries(SHAPES))(
    'flags the independent space corpus that V8 reads in every shape of %s',
    async (name, shapes) => {
      checkSpaces(
        shapes,
        await v8Sweep(shapes, name, { points: [...SPACE_POINTS, ...NOT_SPACE_POINTS] }),
      );
    },
    60_000,
  );

  exhaustiveIt.each(Object.entries(SHAPES))(
    'exhaustive: flags every character that V8 puts between the tokens of %s',
    async (name, shapes) => {
      const ranges = [
        { from: 0, to: 0xffff, step: 1 },
        { from: 0x10000, to: 0x10ffff, step: 211 },
      ] as const;
      const ran = (
        await Promise.all(ranges.map((range) => v8Sweep(shapes, name, range, 270_000)))
      ).flat();
      checkSpaces(shapes, ran);
    },
    300_000,
  );

  const names = ['createRequire', 'eval', 'Function', 'registerHooks'];
  it.each(names)(
    'does not split %s at V8-verified members of independent identifier classes',
    async (name) => {
      const { after, before } = await v8IdentifierParts(name, {
        points: [
          ...IDENTIFIER_START_POINTS,
          ...IDENTIFIER_CONTINUE_ONLY_POINTS,
          ...NOT_IDENTIFIER_POINTS,
        ],
      });
      expect(sorted(before)).toEqual(sorted(IDENTIFIER_START_POINTS));
      expect(sorted(after)).toEqual(
        sorted([...IDENTIFIER_START_POINTS, ...IDENTIFIER_CONTINUE_ONLY_POINTS]),
      );
      expect(after.filter((cp) => flagged(`x.${name}${String.fromCodePoint(cp)}(1)`))).toEqual([]);
      expect(before.filter((cp) => flagged(`x.${String.fromCodePoint(cp)}${name}(1)`))).toEqual([]);
    },
    60_000,
  );

  exhaustiveIt.each(names)(
    'exhaustive: does not split %s at a character that V8 reads as part of an identifier',
    async (name) => {
      const ranges = [
        { from: 0, to: 0xffff, step: 1 },
        { from: 0x10000, to: 0x10ffff, step: 13 },
      ] as const;
      const parts = await Promise.all(
        ranges.map((range) => v8IdentifierParts(name, range, 270_000)),
      );
      const after = parts.flatMap((p) => p.after);
      const before = parts.flatMap((p) => p.before);
      const split = [
        ...after.filter((cp) => flagged(`x.${name}${String.fromCodePoint(cp)}(1)`)),
        ...before.filter((cp) => flagged(`x.${String.fromCodePoint(cp)}${name}(1)`)),
      ];

      expect(split.map((cp) => `U+${hex(cp, 4).toUpperCase()}`)).toEqual([]);
      // The sweep found the characters it should: the joiners, a middle dot, marks, digits and the signs that ASCII allows.
      for (const cp of [0x24, 0x30, 0x5f, 0xb7, 0x300, 0x903, 0x200c, 0x200d, 0x203f])
        expect(after.includes(cp), `after U+${hex(cp, 4)}`).toBe(true);
      for (const cp of [0x24, 0x5f, 0x430, 0xaa])
        expect(before.includes(cp), `before U+${hex(cp, 4)}`).toBe(true);
      expect(after.includes(0x2e), 'a dot ends a name').toBe(false);
    },
    300_000,
  );
});

describe('the harmless members of process are read as such however they are spelled', () => {
  const HARMLESS = [
    'process.env.X',
    'process.\\u0065nv.X',
    "process['\\x65nv'].X",
    "process['\\u{000000065}nv'].X",
    'process?.env?.X',
    'process /*c*/ . /*d*/ env . X',
    'process\n.env\n.X',
    'process\u2028.env.X',
    'var t = `${process.env.X}`',
    'var t = `a ${`b ${process.argv[2]}`}`',
    'process.nextTick(function () {})',
    'process.on("exit", f)',
    'const { env, argv } = process',
    "const { 'env': e } = process",
    "const { ['env']: e } = process",
    'typeof process !== "undefined" && process.versions',
  ];

  it('reads each as harmless, in both goals, where V8 reads a member of process', async () => {
    const answers = await v8Reads(
      HARMLESS.flatMap((code) => goals.map((goal) => ({ code, goal }))),
    );
    const problems: { kind: string; line: string }[] = [];
    let accepted = 0;
    for (const [index, code] of HARMLESS.entries()) {
      for (const [g, goal] of goals.entries()) {
        const answer = answers[index * goals.length + g]!;
        if (!answer.accepted) continue;
        accepted += 1;
        if (flagged(code))
          problems.push({
            kind: 'flagged though harmless',
            line: `${goal} ${JSON.stringify(code)}`,
          });
      }
    }

    expect(summarize(problems)).toEqual([]);
    expect(accepted).toBeGreaterThan(HARMLESS.length);
  }, 60_000);
});
