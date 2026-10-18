import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CHARS } from '../../src/scan/scanner.js';
import { MAX_ATOMS, extractActionAtoms } from '../../src/provenance/atoms.js';
import { readActionAtoms } from '../../src/provenance/action-atoms.js';

// What an action says is read the way a tool result is read, so that a command spelled across
// lines, or with a long run of flags before its package, names the same package as the plain
// command does. What cannot be read to its end is said to be unread, and the engine decides what
// that costs (see `engine-provenance-action.test.ts`).

const NAME = 'evil-helper-fix';
const pkg = { kind: 'pkg', value: NAME };

describe('extractActionAtoms reads a command spelled the way it would run', () => {
  it.each([
    ['a backslash before the line break and an indented line', `npx \\\n  ${NAME} --apply`],
    ['a backslash before the line break and no indent', `npx \\\n${NAME} --apply`],
    ['an installer wrapped after a backslash', `npm install \\\n  ${NAME}`],
    ['an installer wrapped with no backslash', `npm install\n  ${NAME}`],
    ['a carriage return and a line feed', `npm install \\\r\n  ${NAME}`],
    ['many flags before the package of a runner', `npx ${'-y '.repeat(250)}${NAME} --apply`],
    [
      'many flags before the package of an installer',
      `pip install ${'--quiet '.repeat(70)}${NAME}`,
    ],
    [
      'flags wrapped over many lines',
      `npm install \\\n${'  --save-exact \\\n'.repeat(60)}  ${NAME}`,
    ],
  ])('finds the package after %s, and reads it all', (_name, command) => {
    const { atoms, unread } = extractActionAtoms(command);
    expect(atoms).toContainEqual(pkg);
    expect(unread).toBe(false);
  });

  it('finds what the plain command finds, as it did', () => {
    expect(extractActionAtoms(`npx ${NAME} --apply`).atoms).toContainEqual(pkg);
    expect(extractActionAtoms(`pip install requests ${NAME}`).atoms).toContainEqual(pkg);
  });
});

describe('extractActionAtoms says what it could not read', () => {
  it.each([
    ['flags that run past the window of a runner', `npx ${'-y '.repeat(1200)}${NAME}`],
    [
      'packages that run past the window of an installer',
      `pip install ${'a '.repeat(1500)}${NAME}`,
    ],
    [
      'a wrapped command that runs past the window',
      `npm install \\\n${'  --x \\\n'.repeat(600)}  ${NAME}`,
    ],
    [
      'more packages than are kept',
      Array.from({ length: MAX_ATOMS + 5 }, (_, i) => `npx p${i}`).join('\n'),
    ],
    ['text past the characters it reads', `${'x\n'.repeat(DEFAULT_MAX_CHARS / 2)}\nnpx ${NAME}`],
    ['one line of installers that spends the reading budget', 'npm i a '.repeat(25_000)],
  ])('reports %s as unread', (_name, command) => {
    const { atoms, unread } = extractActionAtoms(command);
    expect(unread).toBe(true);
    if (!command.startsWith('npm i a')) expect(atoms.some((a) => a.value === NAME)).toBe(false);
  });

  it.each([
    ['a long command that names no package', `echo ${'word '.repeat(2000)}`],
    [
      'a runner followed by a long list of files',
      `npx eslint ${'src/some/path/file.ts '.repeat(200)}`,
    ],
    ['a long line after a separator', `npm install lodash && echo ${'x '.repeat(3000)}`],
    [
      'a long script after an installer line',
      `npm install lodash\n${'  node scripts/build.js --minify --sourcemap\n'.repeat(100)}`,
    ],
    ['a short command', 'npm install left-pad'],
  ])('does not report %s as unread', (_name, command) => {
    expect(extractActionAtoms(command).unread).toBe(false);
  });
});

describe('readActionAtoms', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-reach-'));

  it('reads a Bash command and an MCP call alike, and drops a known package', () => {
    const wrapped = readActionAtoms('Bash', { command: `npx \\\n  ${NAME}` }, cwd);
    expect(wrapped.atoms).toContainEqual(pkg);
    const mcp = readActionAtoms('mcp__srv__run', { command: `npm install \\\n  ${NAME}` }, cwd);
    expect(mcp.atoms).toContainEqual(pkg);
  });

  it('carries the unread flag of a Bash command, and has none for a tool that runs nothing', () => {
    expect(
      readActionAtoms('Bash', { command: `npx ${'-y '.repeat(1200)}${NAME}` }, cwd).unread,
    ).toBe(true);
    expect(readActionAtoms('Read', { file_path: 'x' }, cwd)).toEqual({ atoms: [], unread: false });
    expect(readActionAtoms('Bash', { command: '' }, cwd)).toEqual({ atoms: [], unread: false });
  });
});
