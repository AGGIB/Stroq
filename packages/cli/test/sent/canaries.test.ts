import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashSecret } from '@stroq/core';
import {
  canariesIn,
  canariesNotFound,
  decoyFiles,
  isCanaryValue,
} from '../../src/sent/canaries.js';
import { canaryValue } from '../../src/commands/canary.js';

/** Canaries are read where they are, never from a stored value. Every value here is made up. */

const CANARY = 'stroq_canary_FAKEcanary0123456789abcdefABCDEF';

describe('isCanaryValue', () => {
  it('knows the shape `stroq canary` makes', () => {
    expect(isCanaryValue(canaryValue())).toBe(true);
    expect(isCanaryValue(CANARY)).toBe(true);
  });

  it.each([
    'stroq_canary_short',
    `${CANARY}x`,
    'stroq_canary_FAKEcanary0123456789abcdefABCD-F',
    'sk_FAKEnotACanary0123456789abcdefABCDEFGHIJK',
  ])('%s is not one', (value) => {
    expect(isCanaryValue(value)).toBe(false);
  });
});

describe('canariesIn', () => {
  it('reads the canary lines of a decoy file, quoted or exported', () => {
    expect(
      canariesIn(`# a decoy\nA=${CANARY}\nexport B="${CANARY}"\nC=not-a-canary\n=${CANARY}`),
    ).toEqual([
      { name: 'A', value: CANARY },
      { name: 'B', value: CANARY },
      { name: 'STROQ_CANARY_KEY', value: CANARY },
    ]);
  });
});

describe('what stroq canary recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'stroq-sent-canaries-'));

  it('lists the decoy files, and nothing from a registry that is not one', () => {
    writeFileSync(join(home, 'canary-files.json'), JSON.stringify({ files: ['/d/a', 7, '/d/b'] }));
    expect(decoyFiles(home)).toEqual(['/d/a', '/d/b']);
    expect(decoyFiles(join(home, 'missing'))).toEqual([]);
  });

  it('counts the planted canaries whose value was not found', () => {
    const other = 'stroq_canary_FAKEother00123456789abcdefABCDE';
    writeFileSync(
      join(home, 'secrets.json'),
      JSON.stringify({
        salt: 's',
        canaries: [{ hash: hashSecret('s', CANARY) }, { hash: hashSecret('s', other) }],
      }),
    );
    expect(canariesNotFound(home, [CANARY])).toBe(1);
    expect(canariesNotFound(home, [CANARY, other])).toBe(0);
    expect(canariesNotFound(join(home, 'missing'), [])).toBe(0);
  });
});
