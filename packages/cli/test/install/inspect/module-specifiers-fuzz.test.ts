import fc from 'fast-check';
import { createContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { scanModules } from '../../../src/install/inspect/module-specifiers.js';

/**
 * Two properties of the reader of module names, which is read against text that a person who wrote the
 * server chose. The reader may say "this module" or "I cannot read this file"; it may not say "nothing"
 * about a file that asks for a module.
 *
 * 1. Known imports wrapped in harmless noise (comments, blanks of every kind, strings and regular
 *    expressions that hold import-like text) are always found, and nothing in the noise is.
 * 2. Against V8 itself: random text made of the characters that make a lexer go wrong (quotes, slashes,
 *    comment openers, backticks, HTML-like comments, escapes) is wrapped around a call of `require`; if V8
 *    runs that call, the reader found the module or flagged the file. V8 is the oracle for what is code.
 *
 * The strings here are source text for the reader. None of it is run except in property 2, and there only
 * in a context that holds nothing but a function that records the names it is asked for.
 */
const NAME = 'zzpkg';

const BLANKS = [
  ' ',
  '  ',
  '\t',
  '\n',
  '\r\n',
  '\r',
  '\u2028',
  '\u2029',
  '\u00a0',
  '\u2003',
  '\u3000',
  '\ufeff',
  '/*c*/',
  '/* \' " ` */',
  '/* a\nb */',
  '/**/',
  '// c\n',
  '// \' " `\n',
  '//\u2028',
] as const;

/** Statements that ask for NAME, as lists of tokens: any blank may stand between two tokens. */
const STATEMENTS: readonly (readonly string[])[] = [
  ['const', 'x', '=', 'require', '(', `'${NAME}'`, ')', ';'],
  ['const', 'x', '=', 'require', '(', `"${NAME}"`, ')', ';'],
  ['require', '(', `\`${NAME}\``, ')', ';'],
  ['x', '=', 'module', '.', 'require', '(', `'${NAME}'`, ')', ';'],
  ['import', 'x', 'from', `'${NAME}'`, ';'],
  ['import', '{', 'a', ',', 'b', '}', 'from', `"${NAME}"`, ';'],
  ['import', '*', 'as', 'ns', 'from', `'${NAME}'`, ';'],
  ['import', `'${NAME}'`, ';'],
  ['export', '*', 'from', `'${NAME}'`, ';'],
  ['export', '{', 'a', '}', 'from', `'${NAME}'`, ';'],
  ['const', 'm', '=', 'await', 'import', '(', `'${NAME}'`, ')', ';'],
  ['import', '(', `'${NAME}'`, ')', '.', 'then', '(', 'f', ')', ';'],
];

/** Lines that read as imports to a reader that does not tell code from text, and are not code. */
const HARMLESS = [
  'const s1 = \'import x from "evil"\';',
  'const s2 = "require(\'evil\')";',
  "const s3 = `import('evil')`;",
  "// require('evil')\n",
  "/* import 'evil' */",
  'const re = /[\'"`]/g;',
  "const re2 = /require\\('evil'\\)/;",
  'const re3 = /[/]{/;',
  'const d = a / b / c;',
  "const t = `${1 + 1} require('evil')`;",
  "x = y / 2; // '",
  'const u = \'\\\'\' + "\\"";',
  'const o = { a: 1, b: [2, 3] };',
  'function f(a, b) { return a / b; }',
  '\n',
  '',
] as const;

const blank = fc.constantFrom(...BLANKS);
const harmless = fc.constantFrom(...HARMLESS);

/** A statement with a blank between every pair of tokens. */
const statement = fc
  .tuple(fc.constantFrom(...STATEMENTS), fc.array(blank, { minLength: 24, maxLength: 24 }))
  .map(([tokens, blanks]) => tokens.map((token, i) => `${token}${blanks[i] ?? ' '}`).join(''));

describe('known imports in harmless noise', () => {
  it('are found, with nothing left unread and nothing taken from the noise', () => {
    fc.assert(
      fc.property(
        fc.array(harmless, { maxLength: 4 }),
        statement,
        fc.array(harmless, { maxLength: 4 }),
        (before, wanted, after) => {
          const text = `${before.join('\n')}\n${wanted}\n${after.join('\n')}\n`;
          const scan = scanModules(text);

          expect(scan.specifiers, text).toEqual([NAME]);
          expect(scan.concerns, text).toEqual([]);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it('are found after text that makes the lexer unsure, or the file is flagged', () => {
    const risky = [
      "if (a) /'/.test(b);",
      "x = (a) / 2; s = 'x'; y = (b) / 3;",
      '<!-- comment',
      "'unterminated",
      '/* open',
      '`open',
      'const r = require;',
      'const { createRequire } = a;',
      'eval(a);',
      'f(\\u0072equire);',
      "}\n/'/.test(a);",
    ] as const;
    for (const before of risky) {
      for (const tokens of STATEMENTS) {
        const text = `${before}\n${tokens.join(' ')}\n`;
        const scan = scanModules(text);

        expect(scan.specifiers.includes(NAME) || scan.concerns.length > 0, text).toBe(true);
      }
    }
  });
});

describe('against V8: if the call runs, the reader found it or flagged the file', () => {
  const PIECES = [
    'a',
    'b',
    '1',
    '=',
    '+',
    '-',
    '/',
    '/',
    '*',
    '(',
    ')',
    '{',
    '}',
    '[',
    ']',
    ';',
    ',',
    '.',
    "'",
    '"',
    '`',
    '${',
    '\\',
    '<!--',
    '-->',
    '//',
    '/*',
    '*/',
    '\n',
    ' ',
    '\u2028',
    "/'/",
    '/"/',
    '/`/',
    '/[/]/',
    'typeof ',
    'void ',
    'a / b',
  ] as const;
  const CALLS = [
    `require('${NAME}');`,
    `require /*c*/ ('${NAME}');`,
    `\nrequire\n("${NAME}");`,
    `module.require('${NAME}');`,
    `require(\`${NAME}\`);`,
  ] as const;

  /** Runs `source` as the body of a CommonJS module; the names `require` is asked for, or null if it does not run. */
  function namesAsked(source: string): string[] | null {
    const asked: string[] = [];
    const record = (name: unknown): unknown => {
      asked.push(String(name));
      return {};
    };
    const context = createContext({ require: record, module: { require: record } });
    try {
      new Script(`(function (require, module) {${source}\n})`).runInContext(context, {
        timeout: 200,
      });
      const body = new Script(`(function (require, module) {${source}\n})`).runInContext(context, {
        timeout: 200,
      }) as (a: unknown, b: unknown) => void;
      body(record, { require: record });
      return asked;
    } catch {
      return asked.length > 0 ? asked : null;
    }
  }

  it('holds for random text around a call of require', () => {
    let ran = 0;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...PIECES), { maxLength: 14 }),
        fc.constantFrom(...CALLS),
        fc.array(fc.constantFrom(...PIECES), { maxLength: 6 }),
        (before, call, after) => {
          const source = `${before.join('')}\n${call}\n${after.join('')}`;
          const asked = namesAsked(source);
          if (asked === null || !asked.includes(NAME)) return;
          ran += 1;
          const scan = scanModules(source);

          expect(scan.specifiers.includes(NAME) || scan.concerns.length > 0, source).toBe(true);
        },
      ),
      { numRuns: 4000 },
    );
    // The property is only worth something if V8 ran a good share of the texts.
    expect(ran).toBeGreaterThan(200);
  });
});

describe('the reader is the same for a text that V8 reads as code', () => {
  it('flags the HTML-like comment, which a script reads as a comment and a module does not', () => {
    expect(scanModules("x = 1 <!-- require('zzpkg')").concerns).toContain('doubt');
    expect(scanModules("x = 1\n--> require('zzpkg')").concerns).toContain('doubt');
    expect(scanModules("x = a-->0; require('zzpkg')").specifiers).toEqual(['zzpkg']);
  });
});
