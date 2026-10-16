import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifySpecifier, scanModules } from '../../../src/install/inspect/module-specifiers.js';
import { askNode, nodeParses, oracleAvailable, type Variant } from '../../helpers/node-oracle.js';

/**
 * The reader of module names against Node itself. Each snippet is run by a child node whose resolve hooks
 * record every specifier Node asks for (see `node-oracle.ts`), and the reader, given the same text, must
 * report every one of the packages Node asked for by name, or flag the file as one it cannot read. That
 * is "a superset of what Node requested": the reader may over-report and may refuse, it may not miss.
 *
 * Nothing here is a claim about what the reader should say. What Node did decides what is right.
 *
 * Every string is source text for Node to run in a throw-away folder; the snippets only call `require` and
 * `import` on a package that the hooks answer with an empty stub.
 */
const NAME = 'zzpkg';

interface Snippet {
  readonly name: string;
  readonly code: string;
  /** The goal Node reads it in: a module (`.mjs`) or a script (`.cjs`). */
  readonly goal: 'module' | 'script';
  /** The packages Node must be seen to ask for; empty when Node cannot run the text, which is then part of the table. */
  readonly asks: readonly string[];
  /** Also run it as a `.js` file under a `package.json` of the matching type. */
  readonly alsoAsJs?: true;
  /** Syntax that only some versions of Node parse: where this one does not, Node asks for nothing. */
  readonly needs?: 'source' | 'defer';
}

const script = (name: string, code: string, asks: readonly string[] = [NAME]): Snippet => ({
  name,
  code,
  goal: 'script',
  asks,
});
const module_ = (name: string, code: string, asks: readonly string[] = [NAME]): Snippet => ({
  name,
  code,
  goal: 'module',
  asks,
});

const FILLER = '1;'.repeat(50_000);
const HUGE_LINE_COMMENTS = '//x\n'.repeat(50_000);

const SNIPPETS: readonly Snippet[] = [
  // Comments in every position.
  { ...script('require', "require('zzpkg')"), alsoAsJs: true },
  script('comment before', "// c\nrequire('zzpkg')"),
  script('block comment before', "/* c */require('zzpkg')"),
  script('comment between require and the bracket', "require /*c*/ ('zzpkg')"),
  script('line break between require and the bracket', "require\n('zzpkg')"),
  script('line comment between', "require // c\n('zzpkg')"),
  script('quotes in comments around it', "/* ' */ require('zzpkg') /* ' */ // \""),
  script('block comment with a break', "/* a\nb */require('zzpkg')"),
  {
    ...module_('import with comments everywhere', "import /*a*/ x /*b*/ from /*c*/ 'zzpkg' // d"),
    alsoAsJs: true,
  },
  module_(
    'braces with comments',
    "import /* a */ { /* b */ x /* c */ } /* d */ from /* e */ 'zzpkg'",
  ),
  module_('import over lines', "import {\n  a,\n  b\n} from\n'zzpkg'"),
  module_('dynamic import over lines', "import(\n  'zzpkg'\n).catch(() => {})"),
  module_('dynamic import with comments', "import /*x*/ ( /*y*/ 'zzpkg' /*z*/ ).catch(() => {})"),
  // HTML-like comments belong to the script goal.
  script('html comment opening', "<!-- comment\nrequire('zzpkg')"),
  script('html comment after code', "var a = 1; <!-- comment\nrequire('zzpkg')"),
  script('html comment closing', "var a = 1\n--> comment\nrequire('zzpkg')"),
  script('html closing after a block comment', "/* a\n*/ --> comment\nrequire('zzpkg')"),
  script('html comment on the same line is code', "var a = 4; var b = a-->0; require('zzpkg')"),
  module_('html comment is not allowed in a module', "<!-- c\nimport 'zzpkg'", []),
  // Templates.
  script('template hole', "var t = `${require('zzpkg')}`"),
  script('nested template holes', "var t = `${`${require('zzpkg')}`}`"),
  script('three levels of templates', "var t = `${`${`${require('zzpkg')}`}`}`"),
  script('import-like text in a template', "var t = `require('no')`; require('zzpkg')"),
  script('template with a hole then text', "var t = `a${1}require('no')`; require('zzpkg')"),
  script('braces in a hole', "var t = `${ {a: 1}.a }`; require('zzpkg')"),
  script('a backtick in a block comment', "/* ` */ require('zzpkg')"),
  module_('template then dynamic import', "var t = `${1}`; await import('zzpkg')"),
  // Regular expressions and division.
  script('regex with a quote', "var r = /'/; require('zzpkg'); var q = '/'"),
  script('regex with a double quote', 'var r = /"/; require(\'zzpkg\'); var q = "/"'),
  script('regex with a backtick', "var r = /`/; require('zzpkg'); var q = `/`"),
  script('regex with a class holding a slash', "var r = /[/]/; require('zzpkg')"),
  script('regex with an escaped slash', "var r = /\\//; require('zzpkg')"),
  script('regex with braces', "var r = /{/; require('zzpkg'); var s = /}/"),
  script('division', 'var a = 8, b = 2, c = 2; var d = a / b / c; require("zzpkg")'),
  script('division after a bracket', "var a = [8]; var d = a[0] / 2; require('zzpkg')"),
  script('division after a call', "var a = (8) / 2; require('zzpkg')"),
  script(
    'division with a quote after it',
    "var a = (8) / 2, s = 'x', b = (4) / 2; require('zzpkg')",
  ),
  script('regex after a closing bracket', "if (1) /'/.test('x'); require('zzpkg'); var q = '/'"),
  script('regex after a closing brace', "{}\n/'/.test('x'); require('zzpkg'); var q = '/'"),
  script('regex after typeof', "var t = typeof /'/; require('zzpkg'); var q = '/'"),
  script('regex after void', "void /'/; require('zzpkg'); var q = '/'"),
  script('regex in a conditional', "var x = 1 ? /'/ : /\"/; require('zzpkg')"),
  script('regex after a postfix operator is a division', "var i = 4; i++ / 2; require('zzpkg')"),
  script('minified', 'var a=(1)/2,b=/x/g;!function(){return a+(1)/2,require("zzpkg")}()'),
  script('slashes in strings', "var u = 'http://x/y'; require('zzpkg'); var v = 'a/b'"),
  // Statements and forms.
  { ...module_('import x from', "import x from 'zzpkg'"), alsoAsJs: true },
  module_('import default and names', "import x, { y } from 'zzpkg'"),
  module_('import star', "import * as ns from 'zzpkg'"),
  module_('import for effect', "import 'zzpkg'"),
  module_('import with attributes', "import x from 'zzpkg' with { type: 'json' }"),
  { ...module_('import source phase', "import source x from 'zzpkg'"), needs: 'source' },
  { ...module_('import defer', "import defer * as ns from 'zzpkg'"), needs: 'defer' },
  module_('export star', "export * from 'zzpkg'"),
  module_('export star as', "export * as ns from 'zzpkg'"),
  module_('export names', "export { a } from 'zzpkg'"),
  module_('export default from', "export { default } from 'zzpkg'"),
  module_('export default as', "export { a as default } from 'zzpkg'"),
  module_('no blanks', 'import{a}from"zzpkg";export*from"zzpkg"'),
  module_('await import', "const m = await import('zzpkg')"),
  script('import in a script', "import('zzpkg').catch(() => {})"),
  script('a statement without a semicolon before it', "var a = 1\nrequire('zzpkg')"),
  script('a line break before the call and after the name', "var a = 1\nrequire\n(\n'zzpkg'\n)"),
  module_(
    'a statement without a semicolon before an import call',
    "var a = 1\nimport('zzpkg').catch(() => {})",
  ),
  script('module.require', "module.require('zzpkg')"),
  // Node's resolve hooks do not see `require.resolve`, so Node is not heard to ask; the reader still reads it.
  script('require.resolve', "require.resolve('zzpkg')", []),
  script('template literal specifier', 'require(`zzpkg`)'),
  // Names with escapes and line continuations.
  script('hex escape in the name', "require('\\x7azzpkg')", ['zzzpkg']),
  script('unicode escape in the name', "require('\\u{7a}zpkg')", ['zzpkg']),
  script('line continuation in the name', "require('zz\\\npkg')"),
  module_('escape in an import name', "import '\\x7azzpkg'", ['zzzpkg']),
  // Loaders, createRequire and other ways round.
  // Nor does a `createRequire` function go through the hooks: the file is flagged by what it says it uses.
  script('createRequire', "require('module').createRequire(__filename)('zzpkg')", []),
  script('require through a variable', "var r = require; r('zzpkg')"),
  script('a computed name', "require(['zz', 'pkg'].join(''))"),
  script('eval', 'eval(\'require("zzpkg")\')'),
  script('a function made from text', "new Function('require', 'require(\"zzpkg\")')(require)"),
  // Line terminators, blanks, shebang, BOM.
  script('line separator ends a comment', "// c\u2028require('zzpkg')"),
  script('paragraph separator ends a comment', "// c\u2029require('zzpkg')"),
  script('carriage return ends a comment', "// c\rrequire('zzpkg')"),
  script('line separator in a string', "var s = 'a\u2028b'; require('zzpkg')"),
  script('no-break space', "require\u00a0('zzpkg')"),
  script('em space', "require\u2003('zzpkg')"),
  script('ideographic space', "require\u3000('zzpkg')"),
  module_('unicode blanks in an import', "import\u2003x\u00a0from\u3000'zzpkg'"),
  script('shebang', "#!/usr/bin/env node\nrequire('zzpkg')"),
  module_('shebang in a module', "#!/usr/bin/env node\nimport 'zzpkg'"),
  script('byte order mark', "\ufeffrequire('zzpkg')"),
  module_('byte order mark in a module', "\ufeffimport 'zzpkg'"),
  // Size and depth.
  script('a huge line', `${FILLER}require('zzpkg')`),
  module_('a huge file of comments', `${HUGE_LINE_COMMENTS}import 'zzpkg'`),
  script('deep nesting', `${'('.repeat(500)}require('zzpkg')${')'.repeat(500)}`),
  script('deep braces', `${'{'.repeat(300)}require('zzpkg')${'}'.repeat(300)}`),
];

/** The variants a snippet is run in: `.mjs` or `.cjs`, and the `.js` ones where the table asks. */
const variantsOf = (snippet: Snippet): readonly Variant[] => {
  const base: Variant = snippet.goal === 'module' ? 'mjs' : 'cjs';
  return snippet.alsoAsJs === true
    ? [base, snippet.goal === 'module' ? 'js-module' : 'js-commonjs']
    : [base];
};

/** The names Node asked for that are looked up by name. */
const bare = (asked: readonly string[]): string[] =>
  asked.filter((name) => classifySpecifier(name) === 'bare');

/** The reader reports the package, or says the file is one it cannot read. */
const covers = (code: string, name: string): boolean => {
  const scan = scanModules(code);
  return scan.concerns.length > 0 || scan.specifiers.includes(name);
};

/** The names as a set: Node asks twice for a module that two statements of one file both name. */
const setOf = (names: readonly string[]): string[] => [...new Set(names)].sort();

describe.skipIf(!oracleAvailable)('the reader of module names against Node', () => {
  it('asks Node about every snippet and gets answers it can compare', async () => {
    // Syntax that only some versions of Node take is asked of this Node first, so that a row is held to
    // what this Node does and not to what another one did.
    const parses = {
      source: await nodeParses("import source x from 'zzprobe'"),
      defer: await nodeParses("import defer * as ns from 'zzprobe'"),
    };
    const jobs = SNIPPETS.flatMap((snippet) =>
      variantsOf(snippet).map((variant) => ({ snippet, variant })),
    );
    // A pool of a few at a time: each is a process of its own.
    const asked = new Map<string, readonly string[]>();
    const queue = [...jobs];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift())
          asked.set(
            `${job.snippet.name}|${job.variant}`,
            await askNode(job.snippet.code, job.variant),
          );
      }),
    );

    const problems: string[] = [];
    for (const { snippet, variant } of jobs) {
      const names = setOf(bare(asked.get(`${snippet.name}|${variant}`) ?? []));
      const label = `${snippet.name} (${variant})`;
      const supported = snippet.needs === undefined || parses[snippet.needs];
      const expected = supported ? setOf(snippet.asks) : [];
      // The oracle saw what the table says it should: a snippet that Node cannot run is part of the table.
      if (JSON.stringify(names) !== JSON.stringify(expected))
        problems.push(
          `${label}: Node asked for ${JSON.stringify(names)}, the table says ${JSON.stringify(expected)}`,
        );
      // The reader reports each of them, or flags the file.
      for (const name of names)
        if (!covers(snippet.code, name)) problems.push(`${label}: the reader missed ${name}`);
      // A row about syntax that this Node does not take still has to be read by the reader.
      if (!supported) expect(covers(snippet.code, NAME), `${label}: read all the same`).toBe(true);
    }

    expect(problems).toEqual([]);
  }, 300_000);

  it('finds a known import in random harmless noise, as Node does', async () => {
    const noise = [
      'var s1 = \'import x from "evil"\';',
      'var s2 = "require(\'evil\')";',
      "var s3 = `import('evil')`;",
      "// require('evil')\n",
      "/* import 'evil' */",
      'var re = /[\'"`]/g;',
      "var re2 = /require\\('evil'\\)/;",
      'var re3 = /[/]{/;',
      'var d = 8 / 2 / 2;',
      "var t = `${1 + 1} require('evil')`;",
      "var u = 4; u = u / 2; // '",
      'var o = { a: 1, b: [2, 3] };',
      '\n',
    ] as const;
    const blanks = [
      ' ',
      '\n',
      '\t',
      '/*c*/',
      '/* \' " ` */',
      '// c\n',
      '\u2028',
      '\u00a0',
      '\r\n',
    ] as const;
    const statements: readonly (readonly [Snippet['goal'], readonly string[]])[] = [
      ['script', ['var x', '=', 'require', '(', `'${NAME}'`, ')', ';']],
      ['script', ['module', '.', 'require', '(', `"${NAME}"`, ')', ';']],
      ['script', ['import', '(', `'${NAME}'`, ')', '.', 'catch', '(', 'f', ')', ';']],
      ['module', ['import', 'x', 'from', `'${NAME}'`, ';']],
      ['module', ['import', '*', 'as', 'ns', 'from', `'${NAME}'`, ';']],
      ['module', ['import', `'${NAME}'`, ';']],
      ['module', ['export', '*', 'from', `'${NAME}'`, ';']],
      ['module', ['export', '{', 'a', '}', 'from', `'${NAME}'`, ';']],
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.constantFrom(...noise), { maxLength: 4 }),
        fc.constantFrom(...statements),
        fc.array(fc.constantFrom(...blanks), { minLength: 12, maxLength: 12 }),
        async (before, [goal, tokens], gaps) => {
          const wanted = tokens.map((token, i) => `${token}${gaps[i] ?? ' '}`).join('');
          const code = `var f = function () {};\n${before.join('\n')}\n${wanted}\n`;
          const asked = bare(await askNode(code, goal === 'module' ? 'mjs' : 'cjs'));

          expect(asked, code).toContain(NAME);
          const scan = scanModules(code);
          expect(scan.specifiers, code).toContain(NAME);
          expect(scan.concerns, code).toEqual([]);
          expect(scan.specifiers, code).not.toContain('evil');
        },
      ),
      { numRuns: 30 },
    );
  }, 300_000);
});
