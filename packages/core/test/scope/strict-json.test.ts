import { describe, expect, it } from 'vitest';
import { parseStrictJson } from '../../src/scope/strict-json.js';

const reason = (text: string): string | undefined => {
  const parsed = parseStrictJson(text);
  return parsed.ok ? undefined : parsed.reason;
};

describe('parseStrictJson', () => {
  it('returns what JSON.parse returns for ordinary text', () => {
    const text = '{"a":1,"b":[true,null,"x",{"c":2.5}],"d":{"e":"é\\u0041"}}';
    expect(parseStrictJson(text)).toEqual({ ok: true, value: JSON.parse(text) });
  });

  it.each(['', '{', '{"a":1', '{"a":1}x', "{'a':1}", '{"a":1,}', '﻿{}', 'undefined'])(
    'rejects %j as a syntax error',
    (text) => {
      expect(reason(text)).toBe('syntax');
    },
  );

  it('rejects a repeated key, which JSON.parse silently resolves to the last one', () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(reason('{"a":1,"a":2}')).toBe('duplicate-key');
  });

  it('rejects a repeated key at any depth, in an object inside an array too', () => {
    expect(reason('{"x":{"y":{"k":1,"j":2,"k":3}}}')).toBe('duplicate-key');
    expect(reason('{"x":[{"k":1},{"k":1,"k":2}]}')).toBe('duplicate-key');
  });

  it('reads a key the way JSON.parse does, so an escaped spelling is the same key', () => {
    expect(reason('{"a":1,"\\u0061":2}')).toBe('duplicate-key');
    expect(reason('{"é":1,"\\u00e9":2}')).toBe('duplicate-key');
  });

  it('allows the same key in different objects, and a key that equals a string value', () => {
    expect(parseStrictJson('{"a":{"k":1},"b":{"k":2},"c":"a","d":["a","a"]}').ok).toBe(true);
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the key %s at the top level',
    (key) => {
      expect(reason(`{"${key}":{}}`)).toBe('forbidden-key');
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the key %s at any depth', (key) => {
    expect(reason(`{"a":{"b":[{"c":{"${key}":1}}]}}`)).toBe('forbidden-key');
  });

  it('rejects a forbidden key spelled with escapes', () => {
    expect(reason('{"\\u005f_proto__":{}}')).toBe('forbidden-key');
    expect(reason('{"con\\u0073tructor":1}')).toBe('forbidden-key');
  });

  it('does not reject the words when they are values, or only part of a key', () => {
    expect(
      parseStrictJson('{"a":"__proto__","b":["constructor"],"__proto__x":1,"my_prototype":2}').ok,
    ).toBe(true);
  });

  it('does not misread a quote, a brace or a colon inside a string for structure', () => {
    const text = '{"a":"}{\\",:[","b":"x"}';
    expect(parseStrictJson(text)).toEqual({ ok: true, value: JSON.parse(text) });
    expect(reason('{"a":"\\"","a":1}')).toBe('duplicate-key');
  });

  it('refuses nesting deeper than a permit ever is, without recursing', () => {
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect(reason(deep)).toBe('too-deep');
    const ok = `${'['.repeat(30)}${']'.repeat(30)}`;
    expect(parseStrictJson(ok).ok).toBe(true);
  });

  it('reads a large object with many keys in one pass', () => {
    const keys = Array.from({ length: 4000 }, (_, i) => `"k${i}":${i}`);
    expect(parseStrictJson(`{${keys.join(',')}}`).ok).toBe(true);
    expect(reason(`{${[...keys, '"k17":0'].join(',')}}`)).toBe('duplicate-key');
  });
});
