import { describe, expect, it } from 'vitest';
import {
  MAX_ATOMS,
  extractAtoms,
  extractAtomsDeep,
  extractAtomsDeepWithLoss,
} from '../../src/provenance/atoms.js';
import { DEFAULT_MAX_CHARS } from '../../src/scan/scanner.js';

const urls = (count: number, prefix = 'd'): string =>
  Array.from({ length: count }, (_, i) => `https://${prefix}${i}.example.org/p`).join('\n');

describe('extractAtomsDeepWithLoss', () => {
  it('returns what extractAtomsDeep returns, and no loss, for an ordinary result', () => {
    const text = 'Run `npx @sentry-tooling/report-fix --apply`, see https://docs.example.org/fix.';
    const { atoms, truncated } = extractAtomsDeepWithLoss(text);
    expect(atoms).toEqual(extractAtomsDeep(text));
    expect(atoms.length).toBeGreaterThan(0);
    expect(truncated).toBe(false);
  });

  it('reports no loss for empty text and for text without atoms', () => {
    expect(extractAtomsDeepWithLoss('')).toEqual({ atoms: [], truncated: false });
    expect(extractAtomsDeepWithLoss('plain prose about widgets').truncated).toBe(false);
  });

  it('reports no loss for a long result that stays under the atom cap', () => {
    const { atoms, truncated } = extractAtomsDeepWithLoss(urls(80));
    expect(atoms.length).toBeLessThan(MAX_ATOMS);
    expect(truncated).toBe(false);
  });

  it('reports the loss when more distinct atoms were found than the cap keeps', () => {
    const { atoms, truncated } = extractAtomsDeepWithLoss(`${urls(250)}\nnpx evil-helper-fix`);
    expect(atoms).toHaveLength(MAX_ATOMS);
    expect(atoms.some((a) => a.value === 'evil-helper-fix')).toBe(false);
    expect(truncated).toBe(true);
  });

  it('reads a result that fills the cap exactly as cut, since it cannot tell', () => {
    const { atoms, truncated } = extractAtomsDeepWithLoss(urls(MAX_ATOMS / 2));
    expect(atoms).toHaveLength(MAX_ATOMS);
    expect(truncated).toBe(true);
  });

  it('reports the loss when a decoded variant is what overflows the cap', () => {
    const encoded = Buffer.from(urls(300, 'e'), 'utf8').toString('base64');
    const { truncated } = extractAtomsDeepWithLoss(`see https://one.example.org/\n${encoded}`);
    expect(truncated).toBe(true);
  });

  it('reports the loss when the text runs past the characters it reads', () => {
    const filler = 'x\n'.repeat(DEFAULT_MAX_CHARS / 2);
    const { atoms, truncated } = extractAtomsDeepWithLoss(`${filler}\nnpx evil-helper-fix`);
    expect(atoms.some((a) => a.value === 'evil-helper-fix')).toBe(false);
    expect(truncated).toBe(true);
  });

  it('reports no loss for text exactly as long as the characters it reads', () => {
    const text = `npx helper-fix\n${'y\n'.repeat(DEFAULT_MAX_CHARS)}`.slice(0, DEFAULT_MAX_CHARS);
    expect(text).toHaveLength(DEFAULT_MAX_CHARS);
    const { atoms, truncated } = extractAtomsDeepWithLoss(text);
    expect(atoms.some((a) => a.value === 'helper-fix')).toBe(true);
    expect(truncated).toBe(false);
  });
});

describe('extractAtomsDeepWithLoss on a line longer than the part of it that is read', () => {
  const longLine = (head: string) => `${head} ${'a'.repeat(600)} evil-helper-fix`;

  it.each(['npm install', 'npx', 'pip install'])(
    'reports the loss after a %s whose line runs on past the window',
    (head) => {
      const { atoms, truncated } = extractAtomsDeepWithLoss(longLine(head));
      expect(atoms.some((a) => a.value === 'evil-helper-fix')).toBe(false);
      expect(truncated).toBe(true);
    },
  );

  it.each([
    ['a short line', 'npm install lodash'],
    ['a line that ends at a newline inside the window', `npm install lodash\n${'b'.repeat(900)}`],
    ['a command that ends at a separator inside the window', `npx tool; ${'b'.repeat(900)}`],
  ])('reports no loss for %s', (_name, text) => {
    expect(extractAtomsDeepWithLoss(text).truncated).toBe(false);
  });

  const wrappedInstall = (flags: number) =>
    `Install with:\n\nnpm install\n${'  --loglevel=silent\n'.repeat(flags)}  evil-helper-fix\n`;

  it('reports the loss when a wrapped command runs on past the window once its lines are joined', () => {
    const { atoms, truncated } = extractAtomsDeepWithLoss(wrappedInstall(40));
    expect(atoms.some((a) => a.value === 'evil-helper-fix')).toBe(false);
    expect(truncated).toBe(true);
  });

  it('still records the package of a short wrapped command, with no loss', () => {
    const { atoms, truncated } = extractAtomsDeepWithLoss(wrappedInstall(1));
    expect(atoms.some((a) => a.value === 'evil-helper-fix')).toBe(true);
    expect(truncated).toBe(false);
  });

  it('reports the loss when the wrapped lines end each with a backslash', () => {
    const text = `npm install \\\n${'  --save-exact \\\n'.repeat(40)}  evil-helper-fix\n`;
    const { atoms, truncated } = extractAtomsDeepWithLoss(text);
    expect(atoms.some((a) => a.value === 'evil-helper-fix')).toBe(false);
    expect(truncated).toBe(true);
  });

  // The continuation pass joins every indented line, so an installer in an indented block is
  // followed by the whole block as one line. That is not a wrapped command unless it says so:
  // a backslash, or an argument line that starts with a flag.
  const steps = (count: number) =>
    Array.from({ length: count }, (_, i) => `      - run: npm test -- --shard=${i}/${count}`).join(
      '\n',
    );
  it.each([
    ['a workflow step', `jobs:\n  build:\n    steps:\n      - run: npm install\n${steps(20)}\n`],
    [
      'a Makefile recipe',
      `install:\n\tnpm install\n${Array.from({ length: 20 }, (_, i) => `\tnode scripts/build-${i}.js --minify --sourcemap`).join('\n')}\n`,
    ],
    [
      'an indented README block',
      `## Install\n\n    npm install widgets\n${Array.from({ length: 12 }, (_, i) => `    node dist/index.js --config ./config/production-${i}.json --port 80${i}`).join('\n')}\n`,
    ],
    ['an installer with its flag on its own line', `    npm install -g typescript\n${steps(20)}\n`],
    ['a runner with a dash-list after it', `steps:\n  npx tool\n${steps(20)}\n`],
  ])('reports no loss for %s followed by a long indented block', (_name, text) => {
    expect(text.length).toBeGreaterThan(600);
    expect(extractAtomsDeepWithLoss(text).truncated).toBe(false);
  });

  // `npm install` ends at its last letter, and the part of the line that is read starts there:
  // a space and 511 characters are 512, the whole window; one more character is past it.
  it.each([
    ['512 characters after the installer', 511, false],
    ['513 characters after the installer', 512, true],
  ])('reports the window boundary at %s', (_name, length, cut) => {
    const text = `npm install ${'a'.repeat(length)}`;
    expect(text.length - 'npm install'.length).toBe(length + 1);
    expect(extractAtomsDeepWithLoss(text).truncated).toBe(cut);
  });

  it('reports no loss for a long line that names no runner or installer', () => {
    expect(extractAtomsDeepWithLoss(`${'word '.repeat(400)}`).truncated).toBe(false);
  });
});

describe('extractAtoms keeps its own contract', () => {
  it('still returns at most MAX_ATOMS atoms in text order', () => {
    const atoms = extractAtoms(urls(250));
    expect(atoms).toHaveLength(MAX_ATOMS);
    expect(atoms[0]).toEqual({ kind: 'url', value: 'https://d0.example.org/p' });
  });
});
