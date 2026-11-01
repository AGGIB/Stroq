import { describe, expect, it } from 'vitest';
import {
  buildPrefilter,
  foldModeOf,
  mayMatch,
  MIN_LITERAL_LENGTH,
} from '../../../src/rules/prefilter/prefilter.js';
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
