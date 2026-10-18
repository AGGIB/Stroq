import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CHARS } from '../../src/scan/scanner.js';
import {
  MAX_ATOMS,
  extractActionAtoms,
  extractAtomsDeepWithLoss,
} from '../../src/provenance/atoms.js';
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

// The shell takes a backslash out of a word (`e\vil` is `evil`, `\pkg` is `pkg`) and removes a
// backslash and the line break after it altogether (`ev\<newline>il` is `evil`), where a page that
// is word-wrapped has a space in its place. Both are read, so neither can hide a package.
describe('extractActionAtoms reads a command the way the shell reads it', () => {
  it.each([
    ['a backslash before the name', `npx \\${NAME}`],
    ['a backslash inside the name', `npx e\\vil-helper-fix`],
    ['a backslash before the name of an installer', `npm install \\${NAME}`],
    ['a backslash inside the name of an installer', `pip install ev\\il-helper-fix`],
    ['a backslash and a line break inside the name', 'npm install ev\\\nil-helper-fix'],
    ['a backslash and a line break inside the name of a runner', 'npx ev\\\nil-helper-fix'],
    ['a backslash, a line break and a carriage return', 'npx ev\\\r\nil-helper-fix'],
    ['a backslash and a line break at a hyphen', 'npx evil-\\\nhelper-fix'],
    ['the name in escaped quotes', `npx \\"${NAME}\\"`],
  ])('finds the package after %s', (_name, command) => {
    expect(extractActionAtoms(command).atoms).toContainEqual(pkg);
  });

  it('still reads the two words of a command wrapped at a space', () => {
    const { atoms } = extractActionAtoms('npm install left-pad \\\n  lodash');
    expect(atoms).toContainEqual({ kind: 'pkg', value: 'left-pad' });
    expect(atoms).toContainEqual({ kind: 'pkg', value: 'lodash' });
  });

  it('keeps the blanks after a removed backslash and line break as a separator', () => {
    const { atoms } = extractActionAtoms('npx evil-\\\n  helper-fix');
    expect(atoms).toContainEqual({ kind: 'pkg', value: 'evil-' });
    expect(atoms.some((a) => a.value === NAME)).toBe(false);
  });

  it('does not take a lone backslash for a package', () => {
    expect(extractActionAtoms('npx \\').atoms.filter((a) => a.kind === 'pkg')).toEqual([]);
  });
});

describe('extractActionAtoms and a runner whose package may be in the part that was cut', () => {
  const filler = '-y '.repeat(800);

  it('reports a second -p past the window as unread, though the first one named a package', () => {
    const { atoms, unread } = extractActionAtoms(`npx -p ok-pkg ${filler}-p ${NAME} run`);
    expect(atoms).toContainEqual({ kind: 'pkg', value: 'ok-pkg' });
    expect(unread).toBe(true);
  });

  it('reports the same for --package', () => {
    expect(extractActionAtoms(`npx --package ok-pkg ${filler}--package ${NAME} run`).unread).toBe(
      true,
    );
  });

  it('does not report a line cut after the first positional word, which settles the package', () => {
    const { atoms, unread } = extractActionAtoms(`npx -p ok-pkg tool ${'x '.repeat(2000)}`);
    expect(atoms).toContainEqual({ kind: 'pkg', value: 'ok-pkg' });
    expect(unread).toBe(false);
    expect(extractActionAtoms(`npx eslint ${'src/a.ts '.repeat(500)}`).unread).toBe(false);
  });

  it('reports a package that is the name of a variable as unread, as a doubt about what it holds', () => {
    expect(extractActionAtoms('npx $PKG --apply').unread).toBe(true);
    expect(extractActionAtoms('npx "$PKG"').unread).toBe(true);
    expect(extractActionAtoms('npx -p $PKG run').unread).toBe(true);
    expect(extractActionAtoms('pip install $PKG').unread).toBe(true);
  });

  it('does not report a path, a flag or a name that holds a variable only for its version', () => {
    for (const command of [
      'npx ./script.js',
      'npx .',
      'npx eslint .',
      'npm install lodash@$VERSION',
      'npx tsx ./a.ts',
    ]) {
      expect(extractActionAtoms(command).unread, command).toBe(false);
    }
  });
});

describe('a page that is read as the shell reads it', () => {
  it('has the package of a name split by a backslash and a line break', () => {
    const { atoms } = extractAtomsDeepWithLoss('Run:\n\nnpm install ev\\\nil-helper-fix\n');
    expect(atoms).toContainEqual(pkg);
  });

  it('does not take a variable in a page for a doubt that marks the session', () => {
    expect(extractAtomsDeepWithLoss('Run `npx $PKG` or `npm install $PKG`.').truncated).toBe(false);
  });
});

// A word is read as the shell reads it: quotes are taken out and the pieces joined, a variable or a
// command in the name is a doubt, and a runner with several -p names each of them.
describe('extractActionAtoms and the quotes in a word', () => {
  it.each([
    ['a quote inside the name', 'npx ev"il"-helper-fix'],
    ['a single-quoted start', "npx 'evil'-helper-fix"],
    ['pieces in both kinds of quote', `npx "e"'vil'-helper-fix`],
    ['a quote after a backslash', 'npx e\\vil"-helper-fix"'],
    ['the whole name in quotes', 'npx "evil-helper-fix"'],
    ['an installer with a quote inside the name', 'pip install ev"il"-helper-fix'],
    ['a backslash inside double quotes that does not escape', 'npx "evil-helper-fix"'],
  ])('finds the package after %s', (_name, command) => {
    expect(extractActionAtoms(command).atoms).toContainEqual(pkg);
  });

  it('reads a backslash that escapes a quote inside double quotes as the shell does', () => {
    expect(extractActionAtoms('npx "evil\\"x"').atoms.some((a) => a.value.includes('evil'))).toBe(
      true,
    );
  });

  it('is in doubt about a quote that is never closed inside a word', () => {
    expect(extractActionAtoms('npx ev"il-helper-fix').unread).toBe(true);
    expect(extractActionAtoms("pip install ev'il").unread).toBe(true);
  });

  it('is not in doubt about the quote that closes the string a command sits in', () => {
    for (const command of [
      'echo "run npx prettier"',
      'git commit -m "docs: use npx prettier"',
      "git commit -m 'use pip install requests'",
    ]) {
      expect(extractActionAtoms(command).unread, command).toBe(false);
    }
  });
});

describe('extractActionAtoms and a name that is built by the shell', () => {
  it.each([
    ['a variable inside the name', 'npx ev$IL-helper-fix'],
    ['a variable in braces', 'npx ${P}'],
    ['a variable after the name starts', 'npm install evil-$SUFFIX'],
    ['a variable in double quotes inside the name', 'npx ev"$IL"-pkg'],
    ['a command substitution inside the name', 'npx ev$(echo il)-helper-fix'],
    ['a backtick inside the name', 'npx ev`echo il`-helper-fix'],
    ['a backtick where the package should be', 'npx `cat name`'],
    ['a backtick where the packages should be', 'npm install foo `cat names`'],
  ])('is in doubt about %s', (_name, command) => {
    expect(extractActionAtoms(command).unread).toBe(true);
  });

  it('is not in doubt about a variable that only holds a version', () => {
    expect(extractActionAtoms('npm install lodash@$VERSION').unread).toBe(false);
    expect(extractActionAtoms('npm install @scope/pkg@$V').unread).toBe(false);
  });

  it('is not in doubt about a command that sits in backticks in a string', () => {
    expect(extractActionAtoms('git commit -m "Run `npx prettier` to format."').unread).toBe(false);
    expect(extractActionAtoms('echo `npx prettier`').unread).toBe(false);
  });

  it('does not read half of a name that a backtick cuts as the name', () => {
    const { atoms } = extractActionAtoms('npx ev`echo il`-helper-fix');
    expect(atoms.some((a) => a.value === 'ev')).toBe(false);
  });
});

describe('extractActionAtoms and a runner with several package names', () => {
  it.each([
    ['two -p', `npx -p ok-pkg -p ${NAME} run`],
    ['two --package', `npx --package ok-pkg --package ${NAME} run`],
    ['--package=', `npx --package=ok-pkg --package=${NAME} run`],
    ['a name stuck to -p', `npx -pok-pkg -p${NAME} run`],
    ['a first -p that names the other one last', `npx -p ${NAME} -p ok-pkg run`],
  ])('names each package of %s', (_name, command) => {
    const { atoms } = extractActionAtoms(command);
    expect(atoms).toContainEqual(pkg);
    expect(atoms).toContainEqual({ kind: 'pkg', value: 'ok-pkg' });
  });

  it('does not name the command when -p names the packages', () => {
    const { atoms } = extractActionAtoms(`npx -p ${NAME} run-this`);
    expect(atoms.some((a) => a.value === 'run-this')).toBe(false);
  });

  it('names the first word that is not a flag when no -p is given, as before', () => {
    expect(extractActionAtoms(`npx -y ${NAME} --apply`).atoms).toContainEqual(pkg);
  });
});

describe('extractActionAtoms and a command wrapped after its first words', () => {
  it('reports a command wrapped with a backslash after a flag that outgrows the window as unread', () => {
    const command = `npx -y \\\n${'  -y \\\n'.repeat(700)}  ${NAME}`;
    expect(extractActionAtoms(command).unread).toBe(true);
  });

  it('reports a long command joined by backslashes with a package past the window as unread', () => {
    const command = `npm install lodash ${'a '.repeat(30)}\\\n${'  b \\\n'.repeat(900)}  ${NAME}`;
    expect(extractActionAtoms(command).unread).toBe(true);
  });

  it('reports no doubt for a short command wrapped after a flag', () => {
    const { atoms, unread } = extractActionAtoms(`npx -y \\\n  ${NAME}`);
    expect(atoms).toContainEqual(pkg);
    expect(unread).toBe(false);
  });
});
