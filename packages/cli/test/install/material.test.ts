import { describe, expect, it } from 'vitest';
import { materialChange } from '../../src/install/material.js';
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
