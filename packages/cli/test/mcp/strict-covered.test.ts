import { describe, expect, it } from 'vitest';
import {
  NO_MEDIA,
  collectLeaves,
  isCovered,
  leafText,
  scanText,
} from '../../src/mcp/strict-leaves.js';
import { STRICT_COPY_SEPARATOR } from '../../src/mcp/strict-limits.js';
import { STRICT_MAX_DEPTH } from '../../src/mcp/strict-limits.js';

/** The post-condition: the scan text is exactly the strings of the structure that is delivered. */

const textOf = (value: unknown, media = NO_MEDIA): string => scanText(value, media) ?? '';

describe('isCovered', () => {
  it('accepts the text that was made from the structure', () => {
    const value = { a: 'one', b: ['two', { c: 'three\nfour' }], n: 1 };
    expect(isCovered(value, NO_MEDIA, textOf(value))).toBe(true);
  });

  it('accepts a structure with no strings: the empty text for an empty one, the copy alone otherwise', () => {
    expect(isCovered({}, NO_MEDIA, '')).toBe(true);
    const numbers = [1, null, false];
    expect(textOf(numbers)).toBe(`${STRICT_COPY_SEPARATOR}[1,null,false]`);
    expect(isCovered(numbers, NO_MEDIA, textOf(numbers))).toBe(true);
    expect(isCovered(numbers, NO_MEDIA, '')).toBe(false);
  });

  it('accepts empty strings, which are strings', () => {
    const value = { a: '', b: ['', 'x'] };
    expect(leafText(value)).toBe('a\n\nb\n\nx');
    expect(isCovered(value, NO_MEDIA, textOf(value))).toBe(true);
  });

  it('refuses a string that is in the structure and not in the text', () => {
    const scanned = { a: 'one' };
    const delivered = { a: 'one', extra: 'smuggled' };
    expect(isCovered(delivered, NO_MEDIA, textOf(scanned))).toBe(false);
  });

  it('refuses a key that is in the structure and not in the text', () => {
    expect(isCovered({ a: 'one', hidden: 1 }, NO_MEDIA, textOf({ a: 'one' }))).toBe(false);
  });

  it('refuses a text that has more than the structure does', () => {
    expect(isCovered({ a: 'one' }, NO_MEDIA, textOf({ a: 'one', b: 'two' }))).toBe(false);
  });

  it('refuses a string that only looks like the scanned one', () => {
    expect(isCovered({ a: 'Ignore all' }, NO_MEDIA, textOf({ a: 'Ignore' }))).toBe(false);
    expect(isCovered({ a: 'one' }, NO_MEDIA, textOf({ a: 'one ' }))).toBe(false);
  });

  it('refuses the same strings in another order', () => {
    expect(isCovered({ a: '1', b: '2' }, NO_MEDIA, textOf({ b: '2', a: '1' }))).toBe(false);
  });

  it('leaves out only the media payload it was told about', () => {
    const image = { type: 'image', data: 'PAYLOAD' };
    const media = new Map<object, string>([[image, 'data']]);
    const value = { content: [image] };
    expect(isCovered(value, media, textOf(value, media))).toBe(true);
    // The payload is not in the text, and the same structure with no media declared needs it there.
    expect(isCovered(value, NO_MEDIA, textOf(value, media))).toBe(false);
  });

  it('refuses a structure nested past the bound', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < STRICT_MAX_DEPTH + 5; i += 1) deep = [deep];
    expect(isCovered(deep, NO_MEDIA, 'bottom')).toBe(false);
    expect(collectLeaves(deep)).toBeNull();
  });
});

describe('isCovered and the serialised copy', () => {
  const value = { a: 'one', b: { c: 'two' } };

  it('requires the copy that follows the decoded strings to be the one this structure makes', () => {
    const text = textOf(value);
    expect(text).toContain(STRICT_COPY_SEPARATOR);
    expect(isCovered(value, NO_MEDIA, text)).toBe(true);
  });

  it('refuses a text with the decoded strings and no copy, where there is room for one', () => {
    expect(isCovered(value, NO_MEDIA, leafText(value) as string)).toBe(false);
  });

  it('refuses a copy of a different structure', () => {
    const other = { a: 'one', b: { c: 'three' } };
    const forged =
      (leafText(value) as string) + textOf(other).slice((leafText(other) as string).length);
    expect(isCovered(value, NO_MEDIA, forged)).toBe(false);
  });

  it('refuses a copy that has been added to or cut', () => {
    const text = textOf(value);
    expect(isCovered(value, NO_MEDIA, `${text} `)).toBe(false);
    expect(isCovered(value, NO_MEDIA, text.slice(0, -1))).toBe(false);
  });

  it('wants no copy for a structure with nothing in it', () => {
    expect(textOf({})).toBe('');
    expect(isCovered({}, NO_MEDIA, '')).toBe(true);
    expect(isCovered([], NO_MEDIA, '')).toBe(true);
  });
});
