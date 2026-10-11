import { describe, expect, it } from 'vitest';
import { candidatesFromText } from '../../src/secrets/candidates.js';

describe('candidate spans at the minimum UTF-16 length', () => {
  it.each([
    ['raw below the minimum', 'a'.repeat(11), []],
    ['raw at the minimum', 'a'.repeat(12), ['a'.repeat(12)]],
    [
      'encoded length meets the minimum, decoded length does not',
      '%41'.repeat(4),
      ['%41'.repeat(4)],
    ],
    [
      'decoded ASCII at the minimum',
      `%41${'B'.repeat(11)}`,
      [`%41${'B'.repeat(11)}`, `A${'B'.repeat(11)}`],
    ],
    [
      'six decoded astral characters are twelve UTF-16 code units',
      encodeURIComponent('\u{1f600}'.repeat(6)),
      [encodeURIComponent('\u{1f600}'.repeat(6)), '\u{1f600}'.repeat(6)],
    ],
    [
      'five decoded astral characters are below the minimum',
      encodeURIComponent('\u{1f600}'.repeat(5)),
      [encodeURIComponent('\u{1f600}'.repeat(5))],
    ],
  ])('%s', (_name, raw, tokens) => {
    expect(candidatesFromText(raw)).toEqual(tokens.map((token) => ({ token, raw })));
  });

  it('keeps whole spans and only sufficiently long tails among short assignments', () => {
    const shortTail = `=${'a'.repeat(11)}`;
    const longTail = `:${'b'.repeat(12)}`;
    const tokens = [shortTail, longTail, 'b'.repeat(12)];

    expect(candidatesFromText(`"a=b" '${shortTail}' "c:d" '${longTail}'`)).toEqual(
      tokens.map((token) => ({ token, raw: token })),
    );
  });

  it('keeps pair order and raw spellings when short, encoded and repeated spans are interleaved', () => {
    const encoded = `%41${'B'.repeat(11)}`;
    const decoded = `A${'B'.repeat(11)}`;

    expect(candidatesFromText(`short ${encoded} a ${decoded} x ${encoded}`)).toEqual([
      { token: encoded, raw: encoded },
      { token: decoded, raw: encoded },
      { token: decoded, raw: decoded },
    ]);
  });
});
