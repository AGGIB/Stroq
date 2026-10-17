import { describe, expect, it } from 'vitest';
import { outsideImportsOfTree } from '../../../src/install/inspect/imports.js';
import { assertSelfContained } from '../../../src/install/mcp-outside-imports.js';
import { scanModules } from '../../../src/install/inspect/module-specifiers.js';
import { buildTree } from '../../../src/install/tree.js';
import type { TreeEntry } from '../../../src/install/types.js';
import { fileEntry } from '../../helpers/install-tree.js';

/**
 * Every limit of the reading of a file and of a tree, held to one rule: reaching it is itself a reason to refuse. A limit
 * never ends the reading with "nothing found", a list that was cut is never what decides, and a hostile file cannot spend
 * a limit on harmless entries so that the dangerous one comes after the point where the reading stops. Each test builds
 * a file that fills the limit with harmless things first and puts the construct that must be refused after them.
 */
const treeOf = (entries: readonly TreeEntry[]) => buildTree([...entries], { complete: true });
const readText = (text: string) => outsideImportsOfTree(treeOf([fileEntry('server.js', text)]));
const refused = (text: string): boolean => readText(text).concerns.length > 0;
const concernsOf = (text: string): readonly string[] => scanModules(text).concerns;
const many = (count: number, make: (i: number) => string, glue = ''): string =>
  Array.from({ length: count }, (_, i) => make(i)).join(glue);

describe('a limit of the reading of one file is a reason to refuse it', () => {
  it('the most specifiers of a file: harmless ones first, then a construct that is refused', () => {
    const harmless = many(2001, (i) => `require('./m${i}');`);

    expect(concernsOf(harmless)).toEqual(['doubt']);
    expect(refused(`${harmless}\nprocess.binding('x')`)).toBe(true);
    // The count is of different names: the same one a thousand times is no limit, and 2000 of them are read.
    expect(concernsOf(many(5000, () => `require('./same');`))).toEqual([]);
    expect(concernsOf(many(2000, (i) => `require('./m${i}');`))).toEqual([]);
  });

  it('the most specifiers: the default is 2000, and a lower one asked for is held to as well', () => {
    expect(
      scanModules(
        many(11, (i) => `require('./m${i}');`),
        10,
      ).concerns,
    ).toEqual(['doubt']);
    expect(
      scanModules(
        many(10, (i) => `require('./m${i}');`),
        10,
      ).concerns,
    ).toEqual([]);
  });

  it('the length of an import or export clause has no limit that hides the module after it', () => {
    const names = many(5000, (i) => `a${i}`, ', ');

    expect(scanModules(`import { ${names} } from 'evilpkg';`).specifiers).toEqual(['evilpkg']);
    expect(scanModules(`export { ${names} } from 'evilpkg';`).specifiers).toEqual(['evilpkg']);
    expect(scanModules(`import d, { ${names} } from 'evilpkg';`).specifiers).toEqual(['evilpkg']);
    expect(scanModules(`import { ${names} } from 'a'; import 'b';`).specifiers).toEqual(['a', 'b']);
    expect(readText(`import { ${names} } from 'evilpkg';`).modules).toEqual(['evilpkg']);
  });

  it('the depth of nested templates: past it the file has a doubt, with a flagged construct after', () => {
    const nested = (depth: number) => `${'`${'.repeat(depth)}1${'}`'.repeat(depth)}`;

    expect(concernsOf(`${nested(70)}; eval('1')`)).toContain('doubt');
    expect(refused(`${nested(70)}; var a = 1`)).toBe(true);
    expect(concernsOf(`${nested(10)}; var a = 1`)).toEqual([]);
  });

  it('the depth of nested brackets: past it the file has a doubt', () => {
    expect(concernsOf(`${'('.repeat(5000)}${')'.repeat(5000)}; var a = 1`)).toEqual(['doubt']);
    expect(concernsOf(`${'['.repeat(5000)}${']'.repeat(5000)}; var a = 1`)).toEqual(['doubt']);
    expect(concernsOf(`${'{'.repeat(5000)}${'}'.repeat(5000)}; var a = 1`)).toEqual(['doubt']);
    expect(concernsOf(`${'('.repeat(4000)}${')'.repeat(4000)}; var a = 1`)).toEqual([]);
  });

  it('the most names set to the global object, process or module: past it the file has a doubt', () => {
    const aliases = (count: number) => many(count, (i) => `var g${i} = globalThis || {};`, '\n');

    expect(concernsOf(aliases(1001))).toContain('doubt');
    expect(refused(`${aliases(1001)}\nvar ok = 1;`)).toBe(true);
    expect(concernsOf(aliases(900))).toEqual([]);
  });

  it('the deepest nesting of braces that is followed: a constructor key taken out by a pattern is refused', () => {
    const deep = (inner: string) => `${'{'.repeat(300)} ${inner} ${'}'.repeat(300)}`;

    expect(refused(deep("const { constructor: C } = function () {}; C('return 1')()"))).toBe(true);
    expect(refused(deep("const { Function: F } = globalThis; F('return 1')()"))).toBe(true);
    expect(refused(deep('const { binding } = process;'))).toBe(true);
    expect(refused(deep("const { r = require } = {}; r('x')"))).toBe(true);
    expect(refused(deep("var o = { constructor: Foo }; o.constructor('1')"))).toBe(true);
    // Deep and harmless is read as before.
    expect(refused(deep('var a = 1; var b = a + 1;'))).toBe(false);
  });

  it('the most keys of one pattern that are kept: a pattern with more on a watched object is refused', () => {
    const keys = (count: number) => many(count, (i) => `k${i}`, ', ');

    expect(refused(`const { ${keys(70)} } = globalThis;`)).toBe(true);
    expect(refused(`const { ${keys(70)} } = process;`)).toBe(true);
    expect(refused(`const { ${keys(70)}, binding } = process;`)).toBe(true);
    expect(refused(`const { ${keys(70)} } = module;`)).toBe(true);
    expect(refused(`const { ${keys(70)} } = config;`)).toBe(false);
    expect(refused(`const { ${keys(20)} } = globalThis;`)).toBe(false);
  });

  it('the deepest nesting of brackets that holds a name back: a name in one is a use at once', () => {
    const inside = (depth: number, body: string) =>
      `${'('.repeat(depth)} ${body} ${')'.repeat(depth)}`;

    expect(refused(inside(511, 'function k(a = (h(1, process))) {}'))).toBe(true);
    expect(refused(inside(520, 'function k(a = (((h(1, process))))) {}'))).toBe(true);
    expect(refused(inside(600, 'function k(a = (((h(1, module))))) {}'))).toBe(true);
    // A parameter list in the same place is still a parameter list.
    expect(refused('function k(a, process) { return process.env }')).toBe(false);
  });

  it('the tokens after a writer: a file name far from the call is still found in its arguments', () => {
    const write = (args: string) => `const fs = require('fs'); fs.writeFileSync(${args});`;

    expect(refused(write("join(a, b, c, d, e, f, g, h, i, j, k, l, m, 'x.js'), data"))).toBe(true);
    expect(refused(write(`${many(40, (i) => `a${i}`, ', ')}, 'evil.cjs'`))).toBe(true);
    expect(refused(write(`f(${many(40, (i) => `a${i}`, ', ')}), 'evil.mjs'`))).toBe(true);
    expect(refused(write("path, 'data.txt'"))).toBe(false);
    // The call ends at its bracket: a name after it is not in it.
    expect(refused(`${write("path, 'data.txt'")} var other = 'x.js';`)).toBe(false);
  });

  it('the length of a command line: padded past 4096 characters it is still a command that starts node with text', () => {
    const spawn = (command: string) =>
      `const cp = require('child_process'); cp.execSync('${command}');`;

    expect(refused(spawn(`node${' '.repeat(5000)}-e "1"`))).toBe(true);
    expect(refused(spawn(`node ${'--no-warnings '.repeat(400)} -e "1"`))).toBe(true);
    expect(refused(spawn(`${'x'.repeat(5000)} node -p 1`))).toBe(true);
    expect(refused(spawn(`npx${' '.repeat(5000)}x`))).toBe(true);
    expect(refused(spawn(`npx ${'x '.repeat(3000)}`))).toBe(true);
    expect(refused(spawn(`git${' '.repeat(5000)}status`))).toBe(false);
  });

  it('the longest chain of members that is remembered: a long chain still ends in what it ends in', () => {
    const chain = many(40, (i) => `a${i}`, '.');

    expect(refused(`x.${chain}.constructor.constructor('return 1')`)).toBe(true);
    expect(refused(`x.${chain}.constructor['constructor']('return 1')`)).toBe(true);
    expect(refused(`x.${chain}.name`)).toBe(false);
  });
});

describe('a limit of the reading of a tree is a reason to refuse it', () => {
  const harmless = (name: string, bytes: number): TreeEntry =>
    fileEntry(name, `// ${'-'.repeat(Math.max(0, bytes - 4))}\n`);

  it('the bytes of text read in all: files past the budget are refused, and the flagged one comes last', () => {
    const tree = treeOf([
      harmless('a1.js', 400),
      harmless('a2.js', 400),
      harmless('a3.js', 400),
      fileEntry('z.js', "process.binding('x')\n"),
    ]);
    const found = outsideImportsOfTree(tree, { budgetBytes: 1000 });

    expect(found.concerns.map((c) => c.concern)).toContain('budget');
    expect(found.concerns.find((c) => c.concern === 'budget')?.files).toEqual(['a3.js', 'z.js']);
    expect(() => assertSelfContained(tree)).toThrow(/process\.binding/);
  });

  it('the bytes of text read in all: the real budget of 24 MiB counts the files that came first', () => {
    const chunk = harmless('x', 1024 * 1024).bytes!;
    const files = Array.from({ length: 25 }, (_, i) =>
      fileEntry(`a${String(i).padStart(2, '0')}.js`, chunk),
    );
    const tree = treeOf([...files, fileEntry('z.js', 'var ok = 1;\n')]);
    const found = outsideImportsOfTree(tree);

    expect(found.concerns.map((c) => c.concern)).toEqual(['budget']);
    expect(found.concerns[0]?.files).toContain('z.js');
  }, 60_000);

  it('a file that is not text is not read, and says so', () => {
    const bytes = new Uint8Array([0x66, 0x6f, 0x6f, 0x00, 0x80]);
    const found = outsideImportsOfTree(treeOf([fileEntry('server.js', bytes)]));

    expect(found.concerns.map((c) => c.concern)).toEqual(['unreadable']);
  });

  it('the packages and files that are listed are the first few: the rest are counted, and decide the same', () => {
    const modules = many(60, (i) => `require('pkg${String(i).padStart(2, '0')}');`);
    const found = readText(modules);

    expect(found.modules).toHaveLength(50);
    expect(found.moduleCount).toBe(60);
    expect(() => assertSelfContained(treeOf([fileEntry('server.js', modules)]))).toThrow(
      /and 55 more/,
    );

    const files = Array.from({ length: 12 }, (_, i) =>
      fileEntry(`f${String(i).padStart(2, '0')}.js`, "process.binding('x')\n"),
    );
    const bad = outsideImportsOfTree(treeOf(files));
    const listed = bad.concerns.find((c) => c.concern === 'dynamic-code');

    expect(listed?.files).toHaveLength(5);
    expect(listed?.count).toBe(12);
    expect(() => assertSelfContained(treeOf(files))).toThrow(/7 more files/);
  });

  it('a long list of harmless packages cannot push a refusal out of the answer', () => {
    // 60 packages sort before `zz`; the file that is flagged is still named by its own concern, which is never cut by them.
    const text = `${many(60, (i) => `require('a${String(i).padStart(2, '0')}');`)}process.binding('x');`;
    const found = readText(text);

    expect(found.moduleCount).toBe(60);
    expect(found.concerns.map((c) => c.concern)).toEqual(['dynamic-code']);
    expect(() => assertSelfContained(treeOf([fileEntry('server.js', text)]))).toThrow(
      /process\.binding/,
    );
  });
});
