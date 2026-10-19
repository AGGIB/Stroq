import { describe, expect, it } from 'vitest';
import { STRICT_ID_SNIFF_CHARS } from '../../src/mcp/strict-limits.js';
import { sniffId } from '../../src/mcp/strict-sniff.js';

/**
 * Finding the request a message that could not be parsed was answering, from its head.
 * The id is only used to decide which waiting request gets Stroq's own error, so being
 * wrong costs one request an early error; but it should not be wrong in ways that are easy
 * to avoid, so it reads the TOP-LEVEL `id` member of the head, token by token, not the
 * first thing that looks like one.
 */

describe('sniffId', () => {
  it('reads a number id and a string id from the head of a well-formed start', () => {
    expect(sniffId('{"jsonrpc":"2.0","id":7,"result":{"content":[')).toBe(7);
    expect(sniffId('{"jsonrpc":"2.0","id":"req-7","result":{')).toBe('req-7');
    expect(sniffId('{ "id" : -3 , "jsonrpc":"2.0"')).toBe(-3);
    expect(sniffId('{"id":0,')).toBe(0);
  });

  it('reads the id wherever it is among the top-level members, inside the window', () => {
    expect(sniffId('{"result":{"content":[]},"jsonrpc":"2.0","id":9}')).toBe(9);
  });

  it('does not take an id from inside a nested value', () => {
    expect(sniffId('{"result":{"id":3,"content":[{"id":4}]},"id":5')).toBe(5);
    expect(sniffId('{"result":{"id":3,"content":[')).toBeNull();
    expect(sniffId('{"result":[{"id":3}')).toBeNull();
  });

  it('does not take an id from inside a string that looks like one', () => {
    expect(sniffId('{"text":"say \\"id\\":3 now","id":8')).toBe(8);
    expect(sniffId('{"text":"\\"id\\": 3')).toBeNull();
  });

  it.each([
    ['a fraction', '{"id":1.5,"result":{'],
    ['an exponent', '{"id":1e3,"result":{'],
    ['an exponent with a sign', '{"id":5E-1,'],
    ['more than fifteen digits', '{"id":1234567890123456,'],
    ['a leading zero', '{"id":007,'],
    ['null', '{"id":null,'],
    ['true', '{"id":true,'],
    ['an object', '{"id":{"a":1},'],
    ['an array', '{"id":[1],'],
    ['a string with an escape', '{"id":"a\\nb",'],
    ['a string past sixty-four characters', `{"id":"${'x'.repeat(65)}",`],
    ['a string that never ends', '{"id":"abc'],
  ])('refuses an id that is %s', (_label, head) => {
    expect(sniffId(head)).toBeNull();
  });

  it('takes the largest integer it accepts and a string of exactly sixty-four characters', () => {
    expect(sniffId('{"id":999999999999999,')).toBe(999_999_999_999_999);
    expect(sniffId(`{"id":"${'x'.repeat(64)}",`)).toBe('x'.repeat(64));
  });

  it('finds nothing after its window, however plain the id is', () => {
    const padding = 'a'.repeat(STRICT_ID_SNIFF_CHARS);
    expect(sniffId(`{"result":"${padding}","id":3}`)).toBeNull();
  });

  it('finds nothing in a head that is not an object, or is empty', () => {
    expect(sniffId('')).toBeNull();
    expect(sniffId('[1, 2, 3]')).toBeNull();
    expect(sniffId('"id":3')).toBeNull();
    expect(sniffId('not json at all')).toBeNull();
  });

  it('does not treat the first batch member as the whole response', () => {
    expect(sniffId('[{"id":3,')).toBeNull();
    expect(sniffId('[ {"id":"req-1",')).toBeNull();
    expect(sniffId('\uFEFF \t[ {"id":3,')).toBeNull();
  });

  it('reads through a leading byte-order mark and blanks', () => {
    expect(sniffId('﻿  {"id":4,')).toBe(4);
  });

  it('takes a number of a different type than a string id of the same digits', () => {
    expect(sniffId('{"id":"3",')).toBe('3');
    expect(sniffId('{"id":3,')).toBe(3);
  });
});
