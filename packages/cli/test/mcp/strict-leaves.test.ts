import { describe, expect, it } from 'vitest';
import { collectLeaves, leafText } from '../../src/mcp/strict-leaves.js';
import { STRICT_MAX_DEPTH } from '../../src/mcp/strict-limits.js';

describe('collectLeaves', () => {
  it('lists every string value and every key in document order, a key before its value', () => {
    expect(collectLeaves({ a: 'x', b: [{ c: 'y' }, 'z'], d: { e: 'w' } })).toEqual([
      'a',
      'x',
      'b',
      'c',
      'y',
      'z',
      'd',
      'e',
      'w',
    ]);
  });

  it('adds nothing for numbers, booleans and null, and finds a bare string', () => {
    expect(collectLeaves({ n: 1, t: true, f: false, z: null })).toEqual(['n', 't', 'f', 'z']);
    expect(collectLeaves('bare')).toEqual(['bare']);
    expect(collectLeaves(42)).toEqual([]);
  });

  it('keeps a key named like an object property, an own `__proto__` included', () => {
    const parsed = JSON.parse('{"__proto__":{"x":"hidden"},"constructor":"c"}') as unknown;
    expect(collectLeaves(parsed)).toEqual(['__proto__', 'x', 'hidden', 'constructor', 'c']);
  });

  it('leaves out the payload of the record it is told is media, and only that one', () => {
    const image = { type: 'image', data: 'PAYLOAD', mimeType: 'image/png' };
    const other = { data: 'TEXT-IN-A-FIELD-CALLED-DATA' };
    const media = new Map<object, string>([[image, 'data']]);
    const leaves = collectLeaves({ content: [image], _meta: other }, media);
    expect(leaves).not.toContain('PAYLOAD');
    expect(leaves).toContain('data');
    expect(leaves).toContain('TEXT-IN-A-FIELD-CALLED-DATA');
  });

  it('follows a structure nested deeper than a recursive walk survives, up to its bound', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < STRICT_MAX_DEPTH - 1; i += 1) deep = [deep];
    expect(collectLeaves(deep)).toEqual(['bottom']);
  });

  it('gives up on a structure nested past the bound instead of walking it', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(collectLeaves(deep)).toBeNull();
    expect(leafText(deep)).toBeNull();
  });
});

describe('leafText', () => {
  it('joins the leaves with a real newline and nothing else', () => {
    expect(leafText({ a: 'one\ntwo', b: 'three' })).toBe('a\none\ntwo\nb\nthree');
  });

  it('is empty for a value with no strings', () => {
    expect(leafText({})).toBe('');
    expect(leafText([1, 2, null])).toBe('');
  });
});
