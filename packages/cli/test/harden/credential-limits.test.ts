import { describe, expect, it } from 'vitest';
import { planBackup } from '../../src/harden/backup.js';
import {
  SCAN_LIMITS,
  findCredentialShape,
  hiddenLineMask,
} from '../../src/harden/credential-shape.js';
import { HIDDEN_LINE } from '../../src/harden/diff.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import type { JsonEdit } from '../../src/harden/types.js';

/**
 * A JSON document is read with the name above each string, and a hostile file can be shaped to
 * make that expensive. Three limits bound it, and a document that goes past one is reported as
 * unchecked, which is not the same as clean: no byte copy is kept of it, and none of its lines
 * from the point where reading stopped is shown in a diff.
 */
const SECRET = 'stroq_attack_fixture_value_0123456789';
const json = (value: unknown, indent?: number): string => JSON.stringify(value, null, indent);

describe('the limits a JSON document is read within', () => {
  it('states them', () => {
    expect(SCAN_LIMITS).toEqual({
      maxKeyChars: 512,
      maxStrings: 50_000,
      maxExamined: 2 * 1024 * 1024,
    });
  });
});

describe('findCredentialShape: a key longer than any key is', () => {
  it('reads a key of 512 characters', () => {
    expect(findCredentialShape(json({ ['k'.repeat(512)]: 'a' }))).toBeNull();
  });

  it('reports a key of 513 characters as unchecked, and not as clean', () => {
    expect(findCredentialShape(json({ ['k'.repeat(513)]: 'a' }))).toBe('unchecked');
  });

  it('reports the same for the key of a list, whatever the list holds', () => {
    expect(findCredentialShape(json({ ['k'.repeat(900)]: ['a', 'b'] }))).toBe('unchecked');
  });

  it('reports the same for a key with nothing under it that is a string', () => {
    expect(findCredentialShape(json({ ['k'.repeat(900)]: 1 }))).toBe('unchecked');
  });

  it('reports a credential it found before it got there', () => {
    const text = json({ env: { API_TOKEN: SECRET }, ['k'.repeat(600)]: 'a' });

    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it('does not report one it never got to, as a named secret', () => {
    const text = json({ ['k'.repeat(600)]: 'a', env: { API_TOKEN: SECRET } });

    expect(findCredentialShape(text)).toBe('unchecked');
  });
});

describe('findCredentialShape: more strings than any config holds', () => {
  const strings = (count: number): string =>
    json({ list: Array.from({ length: count }, () => 'a') });

  it('reads 50,000 strings', () => {
    expect(findCredentialShape(strings(50_000))).toBeNull();
  });

  it('reports 50,001 as unchecked', () => {
    expect(findCredentialShape(strings(50_001))).toBe('unchecked');
  });

  it('counts the strings of every list and object together', () => {
    const text = json({
      a: Array.from({ length: 30_000 }, () => 'a'),
      b: Array.from({ length: 30_000 }, () => 'b'),
    });

    expect(findCredentialShape(text)).toBe('unchecked');
  });

  it('does not count a key or a number as a string', () => {
    const keys = Object.fromEntries(Array.from({ length: 60_000 }, (_, i) => [`k${i}`, i]));

    expect(findCredentialShape(json(keys))).toBeNull();
  });
});

describe('findCredentialShape: the budget of characters examined', () => {
  const small = { ...SCAN_LIMITS, maxExamined: 100 };

  it('reports a document that costs more than the budget as unchecked', () => {
    const text = json({ list: Array.from({ length: 20 }, () => 'abcdefghij') });

    expect(findCredentialShape(text, small)).toBe('unchecked');
  });

  it('reads one that fits', () => {
    expect(findCredentialShape(json({ list: ['abcdefghij'] }), small)).toBeNull();
  });

  it('counts the characters of keys as well as those of strings', () => {
    const keys = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`key-number-${i}`, 1]));

    expect(findCredentialShape(json(keys), small)).toBe('unchecked');
  });

  it('is counted as it goes: a credential before the point where it ran out is still found', () => {
    const text = json({ API_TOKEN: SECRET, list: Array.from({ length: 40 }, () => 'abcdefghij') });

    expect(findCredentialShape(text, { ...SCAN_LIMITS, maxExamined: 150 })).toBe('named-secret');
  });
});

describe('what an unchecked document means for the copy and the diff', () => {
  it('is not copied, and the owner is told that it was too large to check', () => {
    expect(planBackup(json({ ['k'.repeat(600)]: 'a' }))).toEqual({
      backup: 'none-unchecked',
      notices: ['no byte backup: the file is too large to check for credential-shaped text'],
    });
  });

  it('hides the line where reading stopped and every line after it, and shows the lines before', () => {
    const text = json({ model: 'm', ['k'.repeat(600)]: 'a', after: 'z' }, 2);
    const mask = hiddenLineMask(text);
    const lines = text.split('\n');

    expect(lines.map((line, i) => mask(i, line))).toEqual([false, false, true, true, true]);
  });

  it('hides nothing of a document that was read all the way through and holds nothing', () => {
    const text = json({ model: 'm', after: 'z' }, 2);
    const mask = hiddenLineMask(text);

    expect(text.split('\n').some((line, i) => mask(i, line))).toBe(false);
  });

  it('shows the owner a diff with those lines hidden, and says so', () => {
    const text = `${json({ model: 'm', ['k'.repeat(600)]: 'a', after: 'z' }, 2)}\n`;
    const edit: JsonEdit = { kind: 'json-array-add', path: ['permissions', 'deny'], value: 'x' };

    const plan = planJsonEdits('/project/settings.json', [edit], { read: () => text });

    expect(plan.backup).toBe('none-unchecked');
    expect(plan.diff).toContain(HIDDEN_LINE);
    expect(plan.diff).not.toContain('kkkkkkkkkk');
    expect(plan.diff).not.toContain('"after": "z"');
    expect(plan.diff).toContain('"model": "m"');
    expect(plan.notices.some((notice) => notice.includes('hides lines'))).toBe(true);
  });
});
