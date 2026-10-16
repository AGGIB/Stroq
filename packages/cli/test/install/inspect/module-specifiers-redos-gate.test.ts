import { describe, it } from 'vitest';
import { outsideImports } from '../../../src/install/inspect/imports.js';
import { buildInput } from '../../../src/install/inspect/input.js';
import { Findings } from '../../../src/install/inspect/findings.js';
import { moduleSpecifiers } from '../../../src/install/inspect/module-specifiers.js';
import { buildTree } from '../../../src/install/tree.js';
import { expectLinear, repeat, SIZES, type EntryPoint } from '../../helpers/linear-gate.js';
import { fileEntry } from '../../helpers/install-tree.js';

/**
 * The reader of the names a JavaScript file asks for runs over the text of a server, which is written by
 * whoever wrote the server, before anything is decided about installing it. It is a lexer and not a
 * pattern, but a lexer can be quadratic too (a quote that is looked for to the end of the text from
 * every place, a clause read again from every `import`). Each shape below is timed at three sizes, in
 * processor time, with the gate of `inspect-redos-gate.test.ts`.
 */
type Shape = (size: number) => string;

const SHAPES: readonly (readonly [name: string, shape: Shape])[] = [
  ...[
    'import ',
    'import {',
    'import { a,',
    'import a from ',
    "import a from '",
    'import * as ',
    'export {',
    'export * ',
    'export * from ',
    "export { a } from '",
    "require('",
    'require(',
    "import('",
    'import(',
    '`${',
    '`${`${',
    '`',
    '${',
    '}',
    '{',
    '/*',
    '*/',
    '//',
    '/',
    '/[',
    '/\\',
    "'",
    '"',
    "'\\",
    '\\',
    '#!',
    'from',
    'from ',
    '.import(',
    '\u{1f600}',
    '\ud800',
    '\u0000',
  ].map((unit): readonly [string, Shape] => [JSON.stringify(unit), repeat(unit)]),
  ['a long clause that never closes', (size) => `import {${'a,'.repeat(size / 2)}`],
  ['a long string with no end', (size) => `x = '${'a'.repeat(size)}`],
  ['a long template with no end', (size) => `x = \`${'a'.repeat(size)}`],
  ['a long block comment with no end', (size) => `/*${'a'.repeat(size)}`],
  ['a long regular expression with no end', (size) => `x = /${'a'.repeat(size)}`],
  ['many imports with no clause end', (size) => 'import a, '.repeat(size / 10)],
  ['many strings that are not closed on their line', (size) => "x = 'a\n".repeat(size / 7)],
  ['many holes that are not closed', (size) => '`${'.repeat(size / 3)],
  ['many requires of different names', (size) => repeatNames(size)],
];

function repeatNames(size: number): string {
  const lines: string[] = [];
  for (let length = 0, i = 0; length < size; i += 1) {
    const line = `require('pkg-${i}');\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join('');
}

const asTree = (path: string, text: string) =>
  buildTree([fileEntry(path, text)], { complete: true });

const ENTRY_POINTS: readonly (readonly [name: string, run: EntryPoint])[] = [
  ['moduleSpecifiers', (text) => moduleSpecifiers(text)],
  [
    'the reading of a server file',
    (text) => outsideImports(buildInput(asTree('server.js', text), new Findings())),
  ],
];

describe('the reader of module specifiers stays linear on text built to be slow', () => {
  describe.each(ENTRY_POINTS)('%s', (_name, run) => {
    it.each(SHAPES)('%s', (_shape, build) => {
      expectLinear(
        SIZES.map((size) => build(size)),
        run,
      );
    });
  });
});
