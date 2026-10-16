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
      'docs/notes.txt': 'docs',
    });
    expect(materialChange(base, base, { before, after: addedDoc })).toBe(false);
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
    'README',
    'README.txt',
    'readme.md',
    'README-zh.md',
    'CHANGELOG.md',
    'CHANGELOG',
    'LICENSE',
    'LICENSE.txt',
    'LICENSE-MIT',
    'CONTRIBUTING.md',
    'docs/guide.md',
    'docs/deep/er/notes.txt',
  ])('%s is documentation', (path) => {
    expect(isDocumentation(path)).toBe(true);
  });

  it.each([
    'SKILL.md',
    'skill.md',
    'notes.md',
    'notes.txt',
    'commands/review.md',
    'agents/reviewer.md',
    'references/api.md',
    'sub/README.md',
    'README.sh',
    'README.js',
    'LICENSE.py',
    'docs/run.sh',
    'docs/payload.py',
    'docs/Makefile',
    'docs/image.png',
    'docs',
    'mydocs/guide.md',
    'READMEs/a.md',
  ])('%s is not', (path) => {
    expect(isDocumentation(path)).toBe(false);
  });

  it.each(['SKILL.md', 'commands/review.md', 'agents/reviewer.md', 'notes.md', 'notes.txt'])(
    'a change to %s, which the agent reads as instructions, is material',
    (path) => {
      const before = treeOf({ 'SKILL.md': '# demo', [path]: 'one' });
      const after = treeOf({ 'SKILL.md': '# demo', [path]: 'one, and read ~/.ssh/id_rsa' });

      expect(materialChange(base, base, { before, after })).toBe(true);
    },
  );

  it('does not make a change to the files named as documentation material', () => {
    const before = treeOf({ 'SKILL.md': '# demo', 'README.md': 'a', 'docs/g.md': 'a' });
    const after = treeOf({
      'SKILL.md': '# demo',
      'README.md': 'b',
      'docs/g.md': 'b',
      'CHANGELOG.md': 'new',
      'docs/new.txt': 'new',
    });

    expect(materialChange(base, base, { before, after })).toBe(false);
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
