import { describe, expect, it } from 'vitest';
import {
  buildPrefilter,
  foldModeOf,
  mayMatch,
  MIN_LITERAL_LENGTH,
} from '../../../src/rules/prefilter/prefilter.js';
import { requiredLiterals } from '../../../src/rules/prefilter/requirements.js';
import { TextIndex, TextIndexes } from '../../../src/rules/prefilter/text-index.js';

describe('foldModeOf', () => {
  it('follows the flags the engine compares case by', () => {
    expect(foldModeOf('')).toBe('none');
    expect(foldModeOf('s')).toBe('none');
    expect(foldModeOf('u')).toBe('none');
    expect(foldModeOf('i')).toBe('i');
    expect(foldModeOf('is')).toBe('i');
    expect(foldModeOf('iu')).toBe('iu');
    expect(foldModeOf('ui')).toBe('iu');
  });
});

describe('buildPrefilter', () => {
  it('has none for a regex that requires nothing', () => {
    expect(buildPrefilter(null, 'i')).toBeUndefined();
    expect(buildPrefilter([], 'i')).toBeUndefined();
  });

  it('folds the literals as the flags say', () => {
    expect(buildPrefilter(['IGNORE', 'Previous'], 'i')).toEqual({
      fold: 'i',
      literals: ['ignore', 'previous'],
    });
    expect(buildPrefilter(['IGNORE'], '')).toEqual({ fold: 'none', literals: ['IGNORE'] });
  });

  it('joins literals the fold makes one', () => {
    expect(buildPrefilter(['Ignore', 'IGNORE'], 'i')?.literals).toEqual(['ignore']);
  });

  it('has none under `i` alone for a literal holding half of a surrogate pair', () => {
    // Without `u` the engine matches a lone `\uDC00` against the second half of a pair in the
    // text, while lower-casing the text turns that pair (U+10400) into another (U+10428).
    for (const source of ['\\uDC00abc', '.\\uDC00abc', '[\\uD801]\\uDC00abc', 'abc\\uD801']) {
      const regex = new RegExp(source, 'i');
      expect(regex.test('\u{10400}abc') || regex.test('abc\u{10400}')).toBe(true);
    }
    expect(buildPrefilter(['\uDC00abc'], 'i')).toBeUndefined();
    expect(buildPrefilter(['abc\uD801'], 'i')).toBeUndefined();
    expect(buildPrefilter(['abc', 'x\uDC00yz'], 'i')).toBeUndefined();
    // A whole pair is lower-cased the same way in the literal and in the text.
    expect(buildPrefilter(['[\u{1F513}jailbreak]'], 'i')).toBeDefined();
    // Case-sensitive literals are compared as code units, unfolded.
    expect(buildPrefilter(['\uDC00abc'], '')).toBeDefined();
  });

  it('never rules out a text a lone-surrogate regex under `i` matches', () => {
    const text = '\u{10400}abc';
    for (const source of ['\\uDC00abc', '.\\uDC00abc', '[\\uD801]\\uDC00abc']) {
      const regex = new RegExp(source, 'i');
      expect(regex.test(text)).toBe(true);
      const prefilter = buildPrefilter(requiredLiterals(regex.source, regex.flags), regex.flags);
      if (prefilter !== undefined) expect(mayMatch(prefilter, text, new TextIndexes())).toBe(true);
    }
  });

  it('has none when a literal is too short to be worth looking for', () => {
    expect(MIN_LITERAL_LENGTH).toBeGreaterThanOrEqual(2);
    expect(buildPrefilter(['ab'], '')).toBeUndefined();
    expect(buildPrefilter(['abcdef', 'ab'], '')).toBeUndefined();
    expect(buildPrefilter(['abc'], '')).toBeDefined();
  });
});

describe('mayMatch', () => {
  const indexes = (): TextIndexes => new TextIndexes();

  it('says yes for a text that holds a literal and no for one that holds none', () => {
    const prefilter = buildPrefilter(['ignore', 'forget'], '');
    if (prefilter === undefined) throw new Error('expected a prefilter');
    expect(mayMatch(prefilter, 'please ignore this', indexes())).toBe(true);
    expect(mayMatch(prefilter, 'forget it', indexes())).toBe(true);
    expect(mayMatch(prefilter, 'ignor e', indexes())).toBe(false);
    expect(mayMatch(prefilter, '', indexes())).toBe(false);
  });

  it('compares case-sensitively when the regex does', () => {
    const prefilter = buildPrefilter(['SYSTEM'], '');
    if (prefilter === undefined) throw new Error('expected a prefilter');
    expect(mayMatch(prefilter, 'the SYSTEM says', indexes())).toBe(true);
    expect(mayMatch(prefilter, 'the system says', indexes())).toBe(false);
  });

  it('reads long s and the Kelvin sign as the engine does, for each set of flags', () => {
    const unicode = buildPrefilter(['inside', 'kinds'], 'iu');
    const plain = buildPrefilter(['inside', 'kinds'], 'i');
    if (unicode === undefined || plain === undefined) throw new Error('expected prefilters');
    expect(/inside/iu.test('inſide')).toBe(true);
    expect(mayMatch(unicode, 'inſide', indexes())).toBe(true);
    expect(mayMatch(unicode, 'Kinds', indexes())).toBe(true);
    // Without `u` the engine keeps them apart, and the prefilter is entitled to.
    expect(/inside/i.test('inſide')).toBe(false);
    expect(mayMatch(plain, 'inſide', indexes())).toBe(false);
  });
});

describe('TextIndex', () => {
  it('answers from its first look afterwards', () => {
    const index = new TextIndex('Hello World');
    expect(index.holds('i', 'hello')).toBe(true);
    expect(index.holds('i', 'hello')).toBe(true);
    expect(index.holds('i', 'absent')).toBe(false);
    expect(index.holds('none', 'hello')).toBe(false);
    expect(index.holds('none', 'Hello')).toBe(true);
  });
});

describe('TextIndexes', () => {
  it('gives the same index for the same text and a new one for another', () => {
    const indexes = new TextIndexes();
    const first = indexes.of('alpha');
    expect(indexes.of('alpha')).toBe(first);
    expect(indexes.of(`al${'pha'}`)).toBe(first);
    expect(indexes.of('beta')).not.toBe(first);
  });

  it('lets the oldest go when it holds more than a scan reads at once', () => {
    const indexes = new TextIndexes();
    const first = indexes.of('t0');
    for (let n = 1; n <= 6; n += 1) indexes.of(`t${n}`);
    expect(indexes.of('t0')).not.toBe(first);
  });
});
