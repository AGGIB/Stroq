import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
