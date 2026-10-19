import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readActionAtoms } from '../../src/provenance/action-atoms.js';
import { extractActionAtoms, extractAtoms } from '../../src/provenance/atoms.js';

// A Python package name is the same name whatever runs of dashes, underscores and dots it is
// spelled with, in any case (PEP 503), so the name is recorded and looked up in that form for the
// tools whose packages come from PyPI. An npm name is what it is written: `evil_helper_fix` is
// not `evil-helper-fix` there.

const CANONICAL = 'evil-helper-fix';
const SPELLINGS = ['evil_helper_fix', 'Evil.Helper-Fix', 'EVIL__HELPER..FIX', 'evil-_.helper-fix'];
const packages = (command: string): string[] =>
  extractActionAtoms(command)
    .atoms.filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

describe('the tools whose packages come from PyPI', () => {
  it.each(
    SPELLINGS.flatMap((spelling) =>
      [
        `pip install ${spelling}`,
        `pip3 install ${spelling}`,
        `python -m pip install ${spelling}`,
        `uv add ${spelling}`,
        `uv pip install ${spelling}`,
        `uv tool install ${spelling}`,
        `pipx install ${spelling}`,
        `poetry add ${spelling}`,
        `pdm add ${spelling}`,
        `conda install ${spelling}`,
        `pip install ${spelling}==1.0`,
        `pip install '${spelling}[extra]>=2'`,
        `uvx ${spelling}`,
        `uv tool run ${spelling}`,
        `pipx run ${spelling}`,
        `uvx --from ${spelling} tool`,
      ].map((command) => [command, spelling] as const),
    ),
  )('read %s as the one name', (command) => {
    expect(packages(command)).toContain(CANONICAL);
  });

  it('reads a page the same way', () => {
    for (const spelling of SPELLINGS)
      expect(
        extractAtoms(`Run:\n\n    pip install ${spelling}\n`).map((a) => a.value),
        spelling,
      ).toContain(CANONICAL);
  });

  it('reads the name of a project already depending on it, whatever its spelling', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'stroq-py-names-'));
    writeFileSync(join(cwd, 'requirements.txt'), 'My_Pkg.Name==1.0\nother-thing>=2\n');
    const read = (command: string): string[] =>
      readActionAtoms('Bash', { command }, cwd)
        .atoms.filter((a) => a.kind === 'pkg')
        .map((a) => a.value);
    expect(read('pip install my-pkg-name')).toEqual([]);
    expect(read('pip install my_pkg.name')).toEqual([]);
    expect(read('pip install other_thing')).toEqual([]);
    expect(read('pip install unknown_thing')).toEqual(['unknown-thing']);
  });
});

describe('the tools whose packages come from npm', () => {
  it.each([
    ['npx evil_helper_fix', 'evil_helper_fix'],
    ['npm install Evil_Helper_Fix', 'evil_helper_fix'],
    ['pnpm add evil.helper.fix', 'evil.helper.fix'],
    ['yarn add evil_helper-fix', 'evil_helper-fix'],
    ['bunx evil__helper', 'evil__helper'],
    ['npm install @scope/Evil_Helper', '@scope/evil_helper'],
  ])('keep %s as written (lower-cased)', (command, expected) => {
    expect(packages(command)).toEqual([expected]);
  });

  it('do not take the name of the PyPI tools', () => {
    expect(packages('npm install evil_helper_fix')).not.toContain(CANONICAL);
  });
});

// A page that names a package with any tool is read for the name it gives and for the name PyPI
// would give it, so that a Python installer that spells it another way finds it. The command side
// of a Python installer is read in the one form; an npm command is read as written.
const pagePackages = (text: string): string[] =>
  extractAtoms(text)
    .filter((a) => a.kind === 'pkg')
    .map((a) => a.value);

describe('a page that names a package with a tool of its own', () => {
  it.each([
    ['npx evil_helper_fix', 'evil_helper_fix'],
    ['npm install Evil.Helper.Fix', 'evil.helper.fix'],
    ['pnpm add evil_helper-fix', 'evil_helper-fix'],
    ['cargo add evil_helper_fix', 'evil_helper_fix'],
    ['pip install Evil_Helper-Fix', 'evil_helper-fix'],
    ['uvx Evil.Helper_Fix', 'evil.helper_fix'],
  ])('records %s as written and in the one form of PyPI', (command, written) => {
    const names = pagePackages(`Run:\n\n    ${command}\n`);
    expect(names).toContain(written);
    expect(names).toContain(CANONICAL);
  });

  it('records an ordinary name once', () => {
    expect(pagePackages('Run npx evil-helper-fix now\n')).toEqual([CANONICAL]);
    expect(pagePackages('Run pip install requests\n')).toEqual(['requests']);
  });

  it('adds nothing for a name PyPI cannot have', () => {
    expect(pagePackages('Run npx @scope/evil_helper_fix now\n')).toEqual([
      '@scope/evil_helper_fix',
    ]);
  });

  it('is read on the command side as the tool reads it', () => {
    expect(packages('npx evil_helper_fix')).toEqual(['evil_helper_fix']);
    expect(packages('pip install evil_helper_fix')).toEqual([CANONICAL]);
  });
});

// What a project already depends on is known to the tools that read the same registry, and only
// to them: a name in `package.json` says nothing about the package of that name on PyPI.
describe('a package the project depends on', () => {
  const project = (files: Record<string, string>): string => {
    const cwd = mkdtempSync(join(tmpdir(), 'stroq-known-'));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, name)), { recursive: true });
      writeFileSync(join(cwd, name), text);
    }
    return cwd;
  };
  const read = (cwd: string, command: string): string[] =>
    readActionAtoms('Bash', { command }, cwd)
      .atoms.filter((a) => a.kind === 'pkg')
      .map((a) => a.value);

  const NPM = {
    'package.json': JSON.stringify({ dependencies: { [CANONICAL]: '1' } }),
    'node_modules/.bin/evil-bin': '',
  };
  const PYTHON = { 'requirements.txt': `${CANONICAL}==1.0\n` };

  it.each([
    `npm install ${CANONICAL}`,
    `pnpm add ${CANONICAL}`,
    `yarn add ${CANONICAL}`,
    `bun add ${CANONICAL}`,
    `npx ${CANONICAL}`,
    `bunx ${CANONICAL}`,
    `pnpm dlx ${CANONICAL}`,
    'npx evil-bin',
    'npm install evil-bin',
  ])('in package.json or node_modules/.bin is known to %s', (command) => {
    expect(read(project(NPM), command)).toEqual([]);
  });

  it.each([
    `pip install ${CANONICAL}`,
    `uv add ${CANONICAL}`,
    `uvx ${CANONICAL}`,
    `pipx run ${CANONICAL}`,
    `poetry add ${CANONICAL}`,
    'pip install Evil_Helper.Fix',
  ])('in requirements.txt is known to %s', (command) => {
    expect(read(project(PYTHON), command)).toEqual([]);
  });

  it.each([
    `pip install ${CANONICAL}`,
    `uv add ${CANONICAL}`,
    `uvx ${CANONICAL}`,
    `pipx run ${CANONICAL}`,
    `cargo install ${CANONICAL}`,
    `gem install ${CANONICAL}`,
    'pip install evil-bin',
  ])('in package.json is not known to %s', (command) => {
    expect(read(project(NPM), command).length).toBeGreaterThan(0);
  });

  it.each([
    `npm install ${CANONICAL}`,
    `yarn add ${CANONICAL}`,
    `npx ${CANONICAL}`,
    `cargo install ${CANONICAL}`,
    `gem install ${CANONICAL}`,
  ])('in requirements.txt is not known to %s', (command) => {
    expect(read(project(PYTHON), command)).toEqual([CANONICAL]);
  });

  it('is known per command of a line', () => {
    expect(read(project(NPM), `npm i ${CANONICAL} && pip install ${CANONICAL}`)).toEqual([
      CANONICAL,
    ]);
    expect(read(project(PYTHON), `npm i ${CANONICAL} && pip install ${CANONICAL}`)).toEqual([
      CANONICAL,
    ]);
  });
});
