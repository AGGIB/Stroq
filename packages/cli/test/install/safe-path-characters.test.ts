import { describe, expect, it } from 'vitest';
import { checkEntryPath } from '../../src/install/safe-path.js';

// What a path may not contain is decided by Unicode's own properties and not by a list copied from two
// display helpers: a list is only as good as the day it was written, and these were found missing
// (the soft hyphen, the Hangul fillers, the Mongolian free variation selectors, the Arabic letter
// mark, the grapheme joiner...), each of which shows nothing or reorders what is shown. The sweeps
// below ask the engine about every code point there is, so that the day a class is narrowed (or the
// engine learns a new character that is invisible) comes up here as a failure.

const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
const LAST_CODE_POINT = 0x10ffff;
const SURROGATES = { first: 0xd800, last: 0xdfff } as const;

/** The code points named by the review of the first version, which a list of two helpers did not hold. */
const NAMED: readonly (readonly [what: string, first: number, last: number])[] = [
  ['ARABIC LETTER MARK', 0x061c, 0x061c],
  ['SOFT HYPHEN', 0x00ad, 0x00ad],
  ['COMBINING GRAPHEME JOINER', 0x034f, 0x034f],
  ['HANGUL CHOSEONG FILLER and JUNGSEONG FILLER', 0x115f, 0x1160],
  ['KHMER VOWEL INHERENT AQ and AA', 0x17b4, 0x17b5],
  ['MONGOLIAN FREE VARIATION SELECTORS ONE to THREE', 0x180b, 0x180d],
  ['a code point reserved for format characters, assigned to none', 0x2065, 0x2065],
  ['HANGUL FILLER', 0x3164, 0x3164],
  ['HALFWIDTH HANGUL FILLER', 0xffa0, 0xffa0],
  ['SHORTHAND FORMAT LETTER OVERLAP to CONTINUING OVERLAP', 0x1bca0, 0x1bca3],
  ['MUSICAL SYMBOL BEGIN BEAM to END PHRASE', 0x1d173, 0x1d17a],
];

const NAMED_CODE_POINTS: readonly (readonly [label: string, char: string])[] = NAMED.flatMap(
  ([what, first, last]) =>
    Array.from({ length: last - first + 1 }, (_, i) => [
      `${hex(first + i)} ${what}`,
      String.fromCodePoint(first + i),
    ]),
);

// `u`-flag property escapes, written out here and not shared with the code under test.
const CONTROL = /^\p{Cc}$/u;
const HIDDEN = /^[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]$/u;
const BIDI_CONTROL = /^\p{Bidi_Control}$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/** The characters that are refused for what they do to a path and not for what they look like. */
const STRUCTURAL: ReadonlySet<string> = new Set(['\\', ':', '<', '>', '"', '|', '?', '*']);

describe('invisible and direction-changing characters, by property', () => {
  it.each(NAMED_CODE_POINTS)('refuses %s', (_label, char) => {
    for (const path of [`a${char}b`, `${char}a`, `a${char}`, `d${char}/f`, `d/${char}f`, char]) {
      expect(checkEntryPath(path), JSON.stringify(path)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/invisible or direction-changing character/),
      });
    }
  });

  it('refuses every Bidi_Control and every Default_Ignorable_Code_Point character', () => {
    const missed: string[] = [];
    let counted = 0;

    for (let code = 0; code <= LAST_CODE_POINT; code += 1) {
      const char = String.fromCodePoint(code);
      if (!BIDI_CONTROL.test(char) && !DEFAULT_IGNORABLE.test(char)) continue;
      counted += 1;
      if (checkEntryPath(`a${char}b`).ok) missed.push(hex(code));
    }

    expect(missed).toEqual([]);
    // The two properties hold a few thousand code points (the tag block alone is 4096): a sweep that
    // found none has proved nothing.
    expect(counted).toBeGreaterThan(4_000);
  });

  // Every code point, once: refused for exactly the reason of its class, or not refused at all. That
  // the check refuses nothing else is as much a part of the promise as what it refuses, or a skill
  // with a name in any script but Latin could not be looked at.
  it('refuses a code point if and only if its class says so', () => {
    const wrong: string[] = [];

    for (let code = 0; code <= LAST_CODE_POINT; code += 1) {
      const char = String.fromCodePoint(code);
      const verdict = checkEntryPath(`a${char}b`);
      const expected = expectedReason(char, code >= SURROGATES.first && code <= SURROGATES.last);
      if (expected === null) {
        if (!verdict.ok) wrong.push(`${hex(code)}: refused for "${verdict.reason}"`);
      } else if (verdict.ok) {
        wrong.push(`${hex(code)}: accepted`);
      } else if (!expected.test(verdict.reason)) {
        wrong.push(`${hex(code)}: refused for "${verdict.reason}"`);
      }
    }

    expect(wrong).toEqual([]);
  });
});

/** What an independent reading of the classes says about one character in a name, or null for "fine". */
function expectedReason(char: string, isSurrogate: boolean): RegExp | null {
  if (isSurrogate) return /valid Unicode/;
  if (char === '\ufffd') return /replacement character/;
  if (CONTROL.test(char)) return /control character/;
  if (HIDDEN.test(char)) return /invisible or direction-changing character/;
  if (STRUCTURAL.has(char)) return /./;
  return null;
}

describe('characters Windows does not allow in a file name', () => {
  // "On any filesystem" is what a path is promised to be a name on; a name that Windows would refuse,
  // or would read as a wildcard or a redirection, is a name on some of them only.
  it.each(['<', '>', '"', '|', '?', '*'])('refuses %j in any component', (char) => {
    for (const path of [
      `a${char}b`,
      `${char}a`,
      `a${char}`,
      `dir${char}/file`,
      `dir/fi${char}le`,
    ]) {
      expect(checkEntryPath(path), JSON.stringify(path)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/Windows does not allow/),
      });
    }
  });

  it('gives a fixed phrase that does not quote the path', () => {
    const result = checkEntryPath('whatever?.md');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('whatever');
  });

  // CJK names use the full-width forms on purpose, because the ASCII ones are not allowed; they are
  // different characters, and they are names on every filesystem.
  it.each([
    ['full-width less-than', '\uff1ca.md'],
    ['full-width greater-than', 'a\uff1e.md'],
    ['full-width quotation mark', 'a\uff02b.md'],
    ['full-width vertical line', 'a\uff5cb.md'],
    ['full-width question mark', 'what\uff1f.md'],
    ['full-width asterisk', 'a\uff0ab.md'],
    ['full-width colon', 'chapter\uff1a1.md'],
    ['full-width solidus', 'a\uff0fb.md'],
  ])('accepts %s, which is a different character', (_what, path) => {
    expect(checkEntryPath(path)).toEqual({ ok: true, path });
  });
});
