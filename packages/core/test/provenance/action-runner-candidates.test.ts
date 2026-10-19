import { describe, expect, it } from 'vitest';
import { extractActionAtoms, extractAtoms } from '../../src/provenance/atoms.js';

// A runner's package is its first word that is not a flag, but a flag nobody knows may take the
// word after it as a value (`npx --loglevel silent x`), and then the package is the next one. When
// an option of that kind stands before the first word, the next two words are candidates too, so
// that the package is named whichever of them it turns out to be. A runner with nothing like that
// before its package (`npx x run src/file.ts`) names the one package it always did.

const NAME = 'evil-helper-fix';
const packages = (command: string): string[] =>
  extractActionAtoms(command)
    .atoms.filter((a) => a.kind === 'pkg')
    .map((a) => a.value);
const pagePackages = (text: string): string[] =>
  extractAtoms(text)
    .filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

const BEHIND_AN_OPTION: readonly string[] = [
  `npx --loglevel silent ${NAME}`,
  `npx --otp 123456 ${NAME}`,
  `npx -w app ${NAME}`,
  `npx --workspace app ${NAME}`,
  `npx --some-new-flag value ${NAME}`,
  `npx --a 1 --b 2 ${NAME}`,
  `npx -y --loglevel silent ${NAME}`,
  `npm exec --loglevel silent ${NAME}`,
  `npm exec --otp 123456 -- ${NAME}`,
  `pnpm dlx --some-new-flag value ${NAME}`,
  `yarn dlx --some-new-flag value ${NAME}`,
  `bunx --some-new-flag value ${NAME}`,
  `bun x --some-new-flag value ${NAME}`,
  `uvx --prerelease allow ${NAME}`,
  `uvx --default-index https://index.example.test/simple ${NAME}`,
  `uvx --resolution lowest ${NAME}`,
  `uv tool run --prerelease allow ${NAME}`,
  `pipx run --some-new-flag value ${NAME}`,
  `sudo npx --loglevel silent ${NAME}`,
];

describe('a runner behind an option that may take a value', () => {
  it.each(BEHIND_AN_OPTION)('names the package it runs: %s', (command) => {
    const read = extractActionAtoms(command);
    expect(read.atoms).toContainEqual({ kind: 'pkg', value: NAME });
    expect(read.unread).toBe(false);
  });

  it.each(BEHIND_AN_OPTION)('names it from a page, the same way: %s', (command) => {
    expect(pagePackages(`To set up, run:\n\n    ${command}\n\nThen continue.`)).toContain(NAME);
  });

  it('keeps the word the option may have taken, as it did', () => {
    expect(packages(`npx --loglevel silent ${NAME}`)).toEqual(['silent', NAME]);
  });

  it('reads the first three words that are not flags', () => {
    expect(packages('npx --a 1 --b 2 pkg')).toEqual(['1', '2', 'pkg']);
    expect(packages('npx --a 1 --b 2 --c 3 pkg')).not.toContain('pkg');
  });

  it('is no new doubt: a word that cannot be read after the first is just not a name', () => {
    const read = extractActionAtoms('npx --loglevel silent $PKG');
    expect(read.atoms.filter((a) => a.kind === 'pkg').map((a) => a.value)).toEqual(['silent']);
    expect(read.unread).toBe(false);
  });

  it('stops where the command stops', () => {
    expect(packages(`npx --loglevel silent a && npm install ${NAME}`)).toEqual([
      'silent',
      'a',
      NAME,
    ]);
    expect(packages(`npx --loglevel silent a; echo ${NAME}`)).toEqual(['silent', 'a']);
    expect(packages(`npx --loglevel silent a | cat ${NAME}`)).toEqual(['silent', 'a']);
  });
});

describe('a runner with nothing before its package that could take it', () => {
  it.each([
    ['npx tsc --noEmit src/index.ts', ['tsc']],
    ['npx vitest run src/file.test.ts', ['vitest']],
    ['npx -y create-thing my-app --template react', ['create-thing']],
    ['npx --yes create-thing@2 my-app', ['create-thing']],
    ['npx --registry=https://r.example.test x run y', ['x']],
    ['npx -y --quiet x a b c', ['x']],
    ['npx --no-install x a b', ['x']],
    ['pnpm create vite my-app --template react', ['vite', 'create-vite']],
    ['pnpm dlx x a b', ['x']],
    ['bunx --bun x a b', ['x']],
    ['uvx ruff check .', ['ruff']],
    ['uvx --from some-pkg tool a b', ['some-pkg', 'tool']],
    ['pipx run x a b', ['x']],
  ])('names only its package: %s', (command, expected) => {
    expect(packages(command)).toEqual(expected);
  });

  it('is the same from a page', () => {
    expect(pagePackages('Run npx -y create-thing my-app --template react now\n')).toEqual([
      'create-thing',
    ]);
  });
});
