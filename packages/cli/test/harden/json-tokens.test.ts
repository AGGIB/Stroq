import { describe, expect, it } from 'vitest';
import { jsonTokens, type JsonToken } from '../../src/harden/json-tokens.js';
import { cpuNow } from '../helpers/cpu-time.js';

const tokens = (text: string): JsonToken[] => [...jsonTokens(text)];

/** The tokens without where they start, which the tests that do not care about it can compare. */
const shape = (text: string): string[] =>
  tokens(text).map((t) => {
    switch (t.kind) {
      case 'open':
        return t.object ? '{' : '[';
      case 'close':
        return '}';
      case 'key':
        return `key:${t.value}`;
      case 'string':
        return `str:${t.value}`;
      case 'number':
        return `num:${t.text}`;
      case 'word':
        return 'word';
    }
  });

describe('jsonTokens: what it sees', () => {
  it('tells an object’s keys from its string values, and lists everything in order', () => {
    expect(shape('{"a": "b", "c": [1, "d", true, null], "e": {"f": -2.5e3}}')).toEqual([
      '{',
      'key:a',
      'str:b',
      'key:c',
      '[',
      'num:1',
      'str:d',
      'word',
      'word',
      '}',
      'key:e',
      '{',
      'key:f',
      'num:-2.5e3',
      '}',
      '}',
    ]);
  });

  it('does not take a string in an array for a key, even right after an object closes', () => {
    expect(shape('[{"a":1},"b",{"c":"d"}]')).toEqual([
      '[',
      '{',
      'key:a',
      'num:1',
      '}',
      'str:b',
      '{',
      'key:c',
      'str:d',
      '}',
      '}',
    ]);
  });

  it('unescapes strings and keys, and keeps a number exactly as it was written', () => {
    const found = shape('{"a\\u0062": "x\\n\\"y\\"", "n": 1.50, "big": 12345678901234567890}');

    expect(found).toEqual([
      '{',
      'key:ab',
      'str:x\n"y"',
      'key:n',
      'num:1.50',
      'key:big',
      'num:12345678901234567890',
      '}',
    ]);
  });

  it('says where each token starts', () => {
    const text = '{ "a": "b" }';

    expect(tokens(text).map((t) => t.start)).toEqual([0, 2, 7, 11]);
  });

  it('treats a string with a colon or a brace in it as a string', () => {
    expect(shape('{"k": "{:,[]}"}')).toEqual(['{', 'key:k', 'str:{:,[]}', '}']);
  });

  it('skips a byte order mark and white space', () => {
    expect(shape('\u{FEFF} \n\t{ }')).toEqual(['{', '}']);
  });
});

describe('jsonTokens: text that is not what it expects', () => {
  it('never throws and never loops, whatever it is given', () => {
    for (const text of [
      '',
      '"',
      '"abc',
      '"a\\',
      '{"a',
      '}}}',
      ']{[',
      '\u0000\u0001',
      '-',
      '1e',
      'tru',
    ]) {
      expect(() => tokens(text)).not.toThrow();
    }
  });

  it('reads an unterminated string as a string to the end', () => {
    expect(shape('["abc')).toEqual(['[', 'str:abc']);
  });
});

describe('jsonTokens: size', () => {
  it('reads a document nested far deeper than the call stack, with a stack of its own', () => {
    const depth = 300_000;
    const text = `${'['.repeat(depth)}"x"${']'.repeat(depth)}`;

    const all = tokens(text);

    expect(all).toHaveLength(2 * depth + 1);
  });

  it('is linear: a million tokens cost a fraction of a second, not a minute', () => {
    const text = `[${'"a",1,'.repeat(200_000)}null]`;
    const started = cpuNow();

    const count = tokens(text).length;

    expect(count).toBe(400_003);
    expect(cpuNow() - started).toBeLessThan(5_000);
  });
});
