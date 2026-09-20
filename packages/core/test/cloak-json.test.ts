import { describe, expect, it } from 'vitest';
import { collectStrings, mapStrings } from '../src/cloak/json-strings.js';

describe('collectStrings / mapStrings', () => {
  it('reaches every string VALUE, at any depth, and never an object key', () => {
    const value = {
      'a@key.example': 'a@value.example',
      nested: { list: ['x', { deep: 'y' }], n: 7, flag: true, nothing: null },
    };
    expect(collectStrings(value).sort()).toEqual(['a@value.example', 'x', 'y']);
  });

  it('rewrites string values in place and leaves the rest of the shape identical', () => {
    const value = { a: 'one', b: [1, 'two', null], c: { d: 'three' } };
    expect(mapStrings(value, (s) => s.toUpperCase())).toEqual({
      a: 'ONE',
      b: [1, 'TWO', null],
      c: { d: 'THREE' },
    });
  });

  it('does not mutate the input', () => {
    const value = { a: 'one' };
    mapStrings(value, () => 'two');
    expect(value).toEqual({ a: 'one' });
  });

  it('handles a bare string, a bare number and undefined', () => {
    expect(mapStrings('one', (s) => `${s}!`)).toBe('one!');
    expect(mapStrings(7, () => 'x')).toBe(7);
    expect(collectStrings(undefined)).toEqual([]);
  });

  it('stops at a depth bound rather than recursing without limit', () => {
    // Built iteratively so the fixture itself cannot blow the stack.
    let deep: unknown = 'bottom';
    for (let i = 0; i < 500; i += 1) deep = { next: deep };
    expect(() => collectStrings(deep)).not.toThrow();
    expect(collectStrings(deep)).toEqual([]);
  });
});
