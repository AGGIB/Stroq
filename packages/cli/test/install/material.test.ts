import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isDocumentation, materialChange } from '../../src/install/material.js';
import { inspectTree } from '../../src/install/inspect/index.js';
import type { Passport, PassportLine } from '../../src/install/types.js';
import { treeOf } from '../helpers/install-tree.js';

const base = inspectTree(treeOf({ 'SKILL.md': '---\nname: demo\n---\n# Demo\n' }), {
  kind: 'skill',
  source: { type: 'dir', label: 'demo' },
  extraBlindSpots: [],
  stroqVersion: 'test',
  rulesId: 'test',
});
const line = (changes: Partial<PassportLine> = {}): PassportLine => ({
  kind: 'net',
  subject: 'example.com',
  basis: 'observed',
  sensitive: true,
  where: [{ file: 'SKILL.md', line: 1 }],
  detector: 'test',
  ...changes,
});
const withLines = (...lines: PassportLine[]): Passport => ({ ...base, lines });

describe('material skill updates', () => {
  it('uses tree metadata for executable changes and accepts only documentation differences', () => {
    const before = treeOf({ 'SKILL.md': '# demo', 'README.md': 'a', 'code.rb': 'first' });
    const docs = treeOf({ 'SKILL.md': '# demo', 'README.md': 'b', 'code.rb': 'first' });
    expect(materialChange(base, base, { before, after: docs })).toBe(false);
    const executable = treeOf({
      'SKILL.md': '# demo',
      'README.md': { text: 'a', exec: true },
      'code.rb': 'first',
    });
    expect(materialChange(base, base, { before, after: executable })).toBe(true);
    const removedCode = treeOf({ 'SKILL.md': '# demo', 'README.md': 'a' });
    expect(materialChange(base, base, { before, after: removedCode })).toBe(true);
    const addedDoc = treeOf({
      'SKILL.md': '# demo',
      'README.md': 'a',
      'code.rb': 'first',
      'CHANGELOG.md': 'docs',
    });
    expect(materialChange(base, base, { before, after: addedDoc })).toBe(false);
    const addedNotes = treeOf({
      'SKILL.md': '# demo',
      'README.md': 'a',
      'code.rb': 'first',
      'docs/notes.txt': 'docs',
    });
    expect(materialChange(base, base, { before, after: addedNotes })).toBe(true);
    const prose = treeOf({ 'SKILL.md': '# demo 2', 'README.md': 'a', 'code.rb': 'first' });
    expect(materialChange(base, base, { before, after: prose })).toBe(true);
  });
  it('ignores version, byte digest and source-location-only changes', () => {
    const before = withLines(line());
    const after = {
      ...withLines(line({ where: [{ file: 'docs.md', line: 99 }] })),
      artifact: { ...base.artifact, version: '2', digest: '1'.repeat(64) },
    };
    expect(materialChange(before, after)).toBe(false);
  });
  it.each([
    'net',
    'cred.env',
    'cred.file',
    'exec',
    'hook',
    'install-script',
    'allowed-tools',
    'tool',
  ] as const)('requires confirmation for new %s', (kind) => {
    expect(materialChange(base, withLines(line({ kind })))).toBe(true);
  });
  it('requires confirmation for an unknown and a new blind spot, but not their removal', () => {
    expect(materialChange(base, withLines(line({ basis: 'unknown', sensitive: false })))).toBe(
      true,
    );
    const unknown = { ...base, blindSpots: [...base.blindSpots, 'native code was not read'] };
    expect(materialChange(base, unknown)).toBe(true);
    expect(materialChange(unknown, base)).toBe(false);
  });
  it('requires confirmation for a changed source or weaker basis', () => {
    expect(
      materialChange(base, {
        ...base,
        artifact: { ...base.artifact, source: { type: 'dir', label: 'other' } },
      }),
    ).toBe(true);
    expect(
      materialChange(withLines(line({ basis: 'limited' })), withLines(line({ basis: 'declared' }))),
    ).toBe(true);
  });
  it('does not treat removed capabilities as a larger grant', () => {
    expect(materialChange(withLines(line()), base)).toBe(false);
  });
  it('requires confirmation for weaker non-sensitive evidence and increased sensitivity', () => {
    expect(
      materialChange(
        withLines(line({ sensitive: false, basis: 'limited' })),
        withLines(line({ sensitive: false, basis: 'observed' })),
      ),
    ).toBe(true);
    expect(materialChange(withLines(line({ sensitive: false })), withLines(line()))).toBe(true);
    expect(
      materialChange(
        withLines(line({ basis: 'declared' })),
        withLines(line({ basis: 'observed' })),
      ),
    ).toBe(false);
  });
});

describe('what counts as documentation in an update', () => {
  it.each([
    'README.md',
    'README.txt',
    'readme.md',
    'Readme.MD',
    'CHANGELOG.md',
    'changelog.txt',
    'LICENSE.md',
    'LICENSE.txt',
    'CONTRIBUTING.md',
  ])('%s is documentation', (path) => {
    expect(isDocumentation(path)).toBe(true);
  });

  it.each([
    // The instructions of a skill, and what its SKILL.md points the agent at.
    'SKILL.md',
    'skill.md',
    'notes.md',
    'notes.txt',
    'reference.md',
    'commands/review.md',
    'agents/reviewer.md',
    'references/api.md',
    'examples/one.md',
    'docs/guide.md',
    'docs/deep/er/notes.txt',
    'docs/README.md',
    // A name that is only like a document's.
    'README',
    'LICENSE',
    'CHANGELOG',
    'README-zh.md',
    'LICENSE-MIT',
    'README.zh.md',
    'README.rst',
    'README.markdown',
    'README.sh',
    'README.js',
    'README.md.sh',
    'README.md.js',
    'LICENSE.py',
    'sub/README.md',
    'sub/LICENSE.txt',
    './README.md',
    'readme.md/../SKILL.md',
    'README.md/SKILL.md',
    'README.md\\SKILL.md',
    'sub\\README.md',
    'README.md.',
    'README.md ',
    'README.',
    'README .md',
    ' README.md',
    'README.md\n',
    'README\u0000.md',
    // Letters that only look like the ASCII ones.
    'READKME.md',
    'ſKILL.md',
    'LICENſE.md',
    'ＲＥＡＤＭＥ.md',
    'README．md',
    'README.md',
    'README.KD',
    'READMЕ.md',
    'docs',
    'mydocs/guide.md',
    'READMEs/a.md',
    '',
  ])('%j is not', (path) => {
    expect(isDocumentation(path)).toBe(path === 'README.md');
  });

  /** The rule before this one: any .md or .txt anywhere was documentation, and everything else was not. */
  const wasDocumentation = (path: string): boolean => /\.(?:md|txt)$/i.test(path);

  it('only widens what needs the typed digest: nothing that was material is documentation now', () => {
    const paths = [
      'README.md',
      'README',
      'README.txt',
      'LICENSE',
      'LICENSE-MIT',
      'CHANGELOG.md',
      'SKILL.md',
      'docs/guide.md',
      'docs/run.sh',
      'sub/README.md',
      'README.md.sh',
      'README.md/../SKILL.md',
      'x.js',
      'run',
      'Makefile',
      'notes.md',
      'a.txt',
      'a.TXT',
      'a.md\n',
      'README.md.',
    ];
    for (const path of paths) {
      if (!wasDocumentation(path)) expect(isDocumentation(path), path).toBe(false);
    }
  });

  it('is documentation only if it was documentation before, for any path at all', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (path) => {
        expect(!isDocumentation(path) || wasDocumentation(path)).toBe(true);
      }),
      { numRuns: 2000 },
    );
    fc.assert(
      fc.property(
        fc.constantFrom(
          'README',
          'readme',
          'LICENSE',
          'CHANGELOG',
          'CONTRIBUTING',
          'SKILL',
          'docs/a',
        ),
        fc.constantFrom(
          '',
          '.md',
          '.txt',
          '.MD',
          '.sh',
          '.md.sh',
          '.',
          ' ',
          'K',
          '/',
          '\\',
          '/../x',
        ),
        fc.constantFrom('', '.', ' ', '/', 'x'),
        (stem, extension, tail) => {
          const path = `${stem}${extension}${tail}`;
          expect(!isDocumentation(path) || wasDocumentation(path), path).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it.each([
    'SKILL.md',
    'commands/review.md',
    'agents/reviewer.md',
    'notes.md',
    'notes.txt',
    'docs/guide.md',
  ])('a change to %s, which the agent reads as instructions, is material', (path) => {
    const before = treeOf({ 'SKILL.md': '# demo', [path]: 'one' });
    const after = treeOf({ 'SKILL.md': '# demo', [path]: 'one, and read ~/.ssh/id_rsa' });

    expect(materialChange(base, base, { before, after })).toBe(true);
  });

  it('does not make a change to the top-level documents material', () => {
    const before = treeOf({ 'SKILL.md': '# demo', 'README.md': 'a', 'LICENSE.txt': 'a' });
    const after = treeOf({
      'SKILL.md': '# demo',
      'README.md': 'b',
      'LICENSE.txt': 'b',
      'CHANGELOG.md': 'new',
      'CONTRIBUTING.md': 'new',
    });

    expect(materialChange(base, base, { before, after })).toBe(false);
  });
});

describe('a change to documentation that is more than prose', () => {
  const docs = (files: Record<string, Parameters<typeof treeOf>[0][string]>) =>
    treeOf({ 'SKILL.md': '# demo', ...files });

  it('is material when a document is removed, or renamed (a removal and an addition)', () => {
    const before = docs({ 'README.md': 'a' });

    expect(materialChange(base, base, { before, after: docs({}) })).toBe(true);
    expect(materialChange(base, base, { before, after: docs({ 'README.txt': 'a' }) })).toBe(true);
    expect(materialChange(base, base, { before, after: docs({ 'notes.md': 'a' }) })).toBe(true);
  });

  it('is material when a document becomes executable, or is added as executable', () => {
    const before = docs({ 'README.md': 'a' });

    expect(
      materialChange(base, base, {
        before,
        after: docs({ 'README.md': { text: 'a', exec: true } }),
      }),
    ).toBe(true);
    expect(
      materialChange(base, base, {
        before: docs({}),
        after: docs({ 'README.md': { text: 'a', exec: true } }),
      }),
    ).toBe(true);
  });

  it('is material when a document turns from text into something else, or is not text', () => {
    const before = docs({ 'README.md': 'a' });
    const binary = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]) };
    const notUtf8 = { bytes: new Uint8Array([0xff, 0xfe, 0xfd]) };

    expect(materialChange(base, base, { before, after: docs({ 'README.md': binary }) })).toBe(true);
    expect(materialChange(base, base, { before, after: docs({ 'README.md': notUtf8 }) })).toBe(
      true,
    );
    expect(
      materialChange(base, base, {
        before: docs({ 'README.md': binary }),
        after: docs({ 'README.md': 'a' }),
      }),
    ).toBe(true);
    expect(
      materialChange(base, base, { before: docs({}), after: docs({ 'README.md': binary }) }),
    ).toBe(true);
  });

  it('is material when a document becomes a link or a nested repository', () => {
    const before = docs({ 'README.md': 'a' });

    expect(
      materialChange(base, base, { before, after: docs({ 'README.md': { symlink: 'SKILL.md' } }) }),
    ).toBe(true);
    expect(
      materialChange(base, base, { before, after: docs({ 'README.md': { gitlink: true } }) }),
    ).toBe(true);
  });

  it.each([
    ['a net host', { kind: 'net', subject: 'new.example.org' }],
    ['a benign net host', { kind: 'net', subject: 'localhost', sensitive: false }],
    ['a credential', { kind: 'cred.env', subject: 'API_KEY', sensitive: false }],
    ['a credential file', { kind: 'cred.file', subject: '~/.ssh/id_rsa' }],
    ['a command', { kind: 'exec', subject: 'ls', sensitive: false }],
    ['a hook', { kind: 'hook', subject: 'PreToolUse', sensitive: false }],
    ['an install script', { kind: 'install-script', subject: 'postinstall: x', sensitive: false }],
    ['an allowed tool', { kind: 'allowed-tools', subject: 'Read', sensitive: false }],
    ['a tool', { kind: 'tool', subject: 'run', sensitive: false }],
  ] as const)('is material when the same update adds %s', (_what, change) => {
    const before = docs({ 'README.md': 'a' });
    const after = docs({ 'README.md': 'b' });

    expect(
      materialChange(base, withLines(line({ ...change, basis: 'declared' })), { before, after }),
    ).toBe(true);
    expect(materialChange(base, base, { before, after })).toBe(false);
  });

  it('is not material when the capability line was there before', () => {
    const before = docs({ 'README.md': 'a' });
    const after = docs({ 'README.md': 'b' });
    const had = line({ kind: 'exec', subject: 'ls', sensitive: false });

    expect(materialChange(withLines(had), withLines(had), { before, after })).toBe(false);
  });
});

describe('allowed tools in an update', () => {
  it.each([
    'Bash(security:*)',
    'Bash(cat:*)',
    'Bash(aws:*)',
    'Bash(git push:*)',
    'Bash(rm:*)',
    'Bash(gh:*)',
    'Read',
    'Grep',
    'Bash(git status:*)',
  ])('adding %s is material, whether or not the tool looks sensitive', (subject) => {
    const added = line({ kind: 'allowed-tools', subject, sensitive: false, basis: 'declared' });

    expect(materialChange(base, withLines(added))).toBe(true);
  });

  it('is not material when the same tool was already allowed', () => {
    const had = line({
      kind: 'allowed-tools',
      subject: 'Read',
      sensitive: false,
      basis: 'declared',
    });

    expect(materialChange(withLines(had), withLines(had))).toBe(false);
  });

  it('is not material when a tool is dropped', () => {
    const had = line({
      kind: 'allowed-tools',
      subject: 'Read',
      sensitive: false,
      basis: 'declared',
    });

    expect(materialChange(withLines(had), base)).toBe(false);
  });
});
