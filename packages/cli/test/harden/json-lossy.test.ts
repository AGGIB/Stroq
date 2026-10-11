import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLossyJson } from '../../src/harden/json-lossy.js';
import { planJsonEdits } from '../../src/harden/json-edit.js';
import { undoJsonEdits } from '../../src/harden/json-undo.js';
import type { JsonEdit } from '../../src/harden/types.js';
import { cpuNow } from '../helpers/cpu-time.js';
import { removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const addDeny: JsonEdit = { kind: 'json-array-add', path: ['permissions', 'deny'], value: 'x' };
const planOf = (contents: string) =>
  planJsonEdits(join(tempDir(), 'settings.json'), [addDeny], { read: () => contents });

/**
 * A file that parses as JSON and prints back as the same JSON is one the engine can edit. One
 * that does not, because the object it parses to has lost or moved something the file said, is
 * not: writing it back would change what the owner wrote in a place the edit never touched.
 */
describe('findLossyJson: files that cannot be written back as they are', () => {
  it.each([
    ['an integer with more digits than a double holds', '{"big": 12345678901234567890}'],
    ['an integer just past 2^53', '{"n": 9007199254740993}'],
    ['a decimal with more digits than a double holds', '{"x": 1.00000000000000011}'],
    ['a long decimal inside a list', '{"list": [1, [2, 0.30000000000000004999]]}'],
    ['a number too large for a double', '{"huge": 1e400}'],
    ['a negative number too large for a double', '{"huge": -1e999}'],
    ['a number too small for a double', '{"tiny": 1e-400}'],
    ['a negative zero, whose sign printing drops', '{"z": -0}'],
    ['a negative zero written with a decimal point', '{"z": -0.0}'],
  ])('finds %s', (_name, text) => {
    expect(findLossyJson(text)).toMatch(/double/);
  });

  it.each([
    ['at the top', '{"a": 1, "a": 2}'],
    ['in a nested object', '{"x": {"y": {"a": 1, "b": 2, "a": 3}}}'],
    ['in an object in a list', '{"list": [{"a": 1}, {"a": 1, "a": 1}]}'],
    ['when one is written with an escape', '{"a": 1, "\\u0061": 2}'],
  ])('finds a key that appears twice %s', (_name, text) => {
    expect(findLossyJson(text)).toMatch(/same key more than once/);
  });

  it.each([
    ['a number key after a word key', '{"b": 1, "2": 2}'],
    ['number keys that are not in order', '{"2": 1, "1": 2}'],
    ['number keys with a word between them', '{"1": 1, "b": 2, "2": 3}'],
    ['the largest number that is a position', '{"b": 1, "4294967294": 2}'],
    ['a number key in a nested object', '{"o": {"b": 1, "0": 2}}'],
  ])('finds keys that an object would put in another order: %s', (_name, text) => {
    expect(findLossyJson(text)).toMatch(/order/);
  });
});

describe('findLossyJson: files that can', () => {
  it.each([
    ['1.0 for 1', '{"n": 1.0}'],
    ['1e2 for 100', '{"n": 1e2, "m": 1E+2, "o": 1.5e-7}'],
    ['digits that a double keeps exactly', '{"a": 0.1, "b": 1.5, "c": 123456789, "d": -2.25}'],
    ['the largest and smallest doubles', '{"a": 1.7976931348623157e308, "b": 5e-324}'],
    ['an integer that is exactly a double', '{"n": 123456789012345680000}'],
    ['trailing zeros', '{"n": 1.50000000000000000000}'],
    ['zero', '{"a": 0, "b": 0.0, "c": 0e5}'],
    ['a number written as a long string', '{"n": "12345678901234567890"}'],
    ['number keys in order, before the others', '{"1": 1, "2": 2, "b": 3}'],
    ['number keys that are not positions', '{"b": 1, "4294967295": 2, "01": 3, "-1": 4, "1.5": 5}'],
    [
      'the same key in different objects',
      '{"a": {"a": 1}, "b": {"a": 2}, "list": [{"a": 1}, {"a": 2}]}',
    ],
    ['a key that is also a value', '{"a": "a", "b": "a"}'],
    ['numbers in a list', '[1, 1, 1.0, 2]'],
    ['a plain document', '{"permissions": {"deny": ["a", "b"]}, "model": "m"}'],
  ])('finds nothing in %s', (_name, text) => {
    expect(findLossyJson(text)).toBeNull();
  });

  it('is linear in the size of the document', () => {
    const keys = Array.from({ length: 100_000 }, (_, i) => `"k${i}":${i}.5`).join(',');
    const started = cpuNow();

    expect(findLossyJson(`{${keys}}`)).toBeNull();
    expect(findLossyJson(`[${'1.5,'.repeat(300_000)}2]`)).toBeNull();
    expect(findLossyJson(`{"a":${'['.repeat(100_000)}${']'.repeat(100_000)}}`)).toBeNull();

    expect(cpuNow() - started).toBeLessThan(5_000);
  });
});

describe('planJsonEdits: a file that cannot be written back as it is', () => {
  it.each([
    ['a number past double precision', '{\n  "big": 12345678901234567890\n}\n'],
    ['a number out of range', '{\n  "huge": 1e400\n}\n'],
    ['a duplicated key', '{\n  "a": 1,\n  "a": 2\n}\n'],
    ['keys that look like numbers', '{\n  "b": 1,\n  "2": 2\n}\n'],
  ])('refuses %s, and leaves it exactly as it is', (_name, before) => {
    const plan = planOf(before);

    expect(plan.refused).toBe('lossy-json');
    expect(plan.changed).toBe(false);
    expect(plan.after).toBe(before);
    expect(plan.diff).toBe('');
    expect(plan.edits).toEqual([]);
    expect(plan.formatting).toBe('preserved');
  });

  it('says what is wrong without quoting any of it', () => {
    const plan = planOf('{"password": "stroq_attack_fixture_value_0123456789", "n": 1e400}');

    expect(plan.refused).toBe('lossy-json');
    expect(plan.refusedDetail).toMatch(/double/);
    expect(plan.refusedDetail).not.toContain('stroq_attack_');
    expect(plan.refusedDetail).not.toContain('password');
  });

  it('refuses even when the edit would change nothing, so that "no change" is never a way past it', () => {
    const plan = planJsonEdits(join(tempDir(), 'settings.json'), [addDeny], {
      read: () => '{"permissions": {"deny": ["x"]}, "n": 1e400}',
    });

    expect(plan.refused).toBe('lossy-json');
  });

  it('still plans a file whose layout alone would change', () => {
    const plan = planOf('{"permissions":{"deny":["a"]}, "n": 1.0}\n');

    expect(plan.refused).toBeUndefined();
    expect(plan.formatting).toBe('will-change');
  });
});

describe('undoJsonEdits: a file that cannot be written back as it is', () => {
  it('is blocked and untouched, because laying it out again would lose something', () => {
    const made = planOf('{"model": "m"}\n');

    const result = undoJsonEdits('{"permissions": {"deny": ["x"]}, "n": 1e400}', made.edits);

    expect(result).toMatchObject({ outcome: 'blocked', refused: 'lossy-json' });
  });

  it('is blocked for a duplicated key too', () => {
    const made = planOf('{"model": "m"}\n');

    const result = undoJsonEdits('{"a": 1, "a": 2, "permissions": {"deny": ["x"]}}', made.edits);

    expect(result).toMatchObject({ outcome: 'blocked', refused: 'lossy-json' });
  });
});
