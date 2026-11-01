import { describe, expect, it } from 'vitest';
import { requiredLiterals } from '../../../src/rules/prefilter/requirements.js';

/** The literals a regex source needs, sorted, or null when it needs none we are sure of. */
const needs = (source: string, flags = ''): readonly string[] | null => {
  const found = requiredLiterals(source, flags);
  return found === null ? null : [...found].sort();
};

describe('requiredLiterals: concatenation', () => {
  it('takes a plain literal whole', () => {
    expect(needs('abc')).toEqual(['abc']);
  });

  it('keeps the most selective run of a concatenation', () => {
    expect(needs('foo\\s+barbaz')).toEqual(['barbaz']);
    expect(needs('\\bignore\\s+(all\\s+)?previous\\b')).toEqual(['previous']);
  });

  it('breaks a run at a class, a dot, an assertion and a lookaround', () => {
    expect(needs('ab[xy]cdefg')).toEqual(['cdefg']);
    expect(needs('ab.cdefg')).toEqual(['cdefg']);
    expect(needs('ab\\bcdefg')).toEqual(['cdefg']);
    expect(needs('^ab$cdefg')).toEqual(['cdefg']);
    expect(needs('ab(?=x)cdefg')).toEqual(['cdefg']);
    expect(needs('ab(?!x)cdefg')).toEqual(['cdefg']);
    expect(needs('ab(?<=x)cdefg')).toEqual(['cdefg']);
    expect(needs('ab(?<!x)cdefg')).toEqual(['cdefg']);
  });

  it('draws nothing from inside a lookaround', () => {
    expect(needs('(?=abcdef)x')).toEqual(['x']);
    expect(needs('(?!abcdef)')).toBeNull();
    expect(needs('(?<=abcdef)')).toBeNull();
  });

  it('has nothing for a pattern of classes and dots', () => {
    expect(needs('[a-z]+')).toBeNull();
    expect(needs('.*')).toBeNull();
    expect(needs('\\s\\w\\d')).toBeNull();
    expect(needs('')).toBeNull();
    expect(needs('(?:)')).toBeNull();
  });

  it('breaks a class that holds an escaped bracket in the right place', () => {
    expect(needs('[\\]]abcd')).toEqual(['abcd']);
    expect(needs('[^\\]x]abcd')).toEqual(['abcd']);
  });
});

describe('requiredLiterals: quantifiers', () => {
  it('drops an optional element and ends the run before it', () => {
    expect(needs('colou?rs')).toEqual(['colo']);
    expect(needs('instructions?')).toEqual(['instruction']);
    expect(needs('ab*cdefg')).toEqual(['cdefg']);
    expect(needs('ab{0,3}cdefg')).toEqual(['cdefg']);
  });

  it('keeps one copy of an element that must occur and ends the run after it', () => {
    expect(needs('abc+d')).toEqual(['abc']);
    expect(needs('abc{2,}d')).toEqual(['abc']);
    expect(needs('abc{2}d')).toEqual(['abc']);
    expect(needs('abc+?dd')).toEqual(['abc']);
  });

  it('treats a quantifier of exactly one as no quantifier', () => {
    expect(needs('abc{1}d')).toEqual(['abcd']);
    expect(needs('abc{1,1}d')).toEqual(['abcd']);
  });

  it('keeps the requirement of a group that must occur', () => {
    expect(needs('(abcd)+x')).toEqual(['abcd']);
    expect(needs('(?:abcd){2,5}x')).toEqual(['abcd']);
    expect(needs('(abcd){1}x')).toEqual(['abcd']);
  });

  it('drops the requirement of a group that may not occur', () => {
    expect(needs('(abcd)?xy')).toEqual(['xy']);
    expect(needs('(abcd)*xy')).toEqual(['xy']);
    expect(needs('(?:abcd){0,2}xy')).toEqual(['xy']);
    expect(needs('(abcd)?')).toBeNull();
  });

  it('reads a brace that is not a quantifier as text (Annex B)', () => {
    expect(needs('a{')).toEqual(['a{']);
    expect(needs('a{,3}b')).toEqual(['a{,3}b']);
    expect(needs('a{x}')).toEqual(['a{x}']);
    expect(needs('ab}c]d')).toEqual(['ab}c]d']);
  });
});

describe('requiredLiterals: alternation', () => {
  it('takes the union of the branches', () => {
    expect(needs('foo|barbaz')).toEqual(['barbaz', 'foo']);
    expect(needs('(?:ignore|disregard)\\s+x')).toEqual(['disregard', 'ignore']);
  });

  it('has nothing when any branch has nothing', () => {
    expect(needs('foo|\\d+')).toBeNull();
    expect(needs('foo|')).toBeNull();
    expect(needs('|foo')).toBeNull();
    expect(needs('(foo|)bar')).toEqual(['bar']);
    expect(needs('(foo|[a-z])')).toBeNull();
  });

  it('uses each branch its own best run', () => {
    expect(needs('ab[x]cdef|gh\\sijklm')).toEqual(['cdef', 'ijklm']);
  });

  it('prefers the shorter list when two requirements are as long', () => {
    expect(needs('(foo|bar)baz')).toEqual(['baz']);
    expect(needs('(foo|bar|qux)baz')).toEqual(['baz']);
  });

  it('prefers the longer literals', () => {
    expect(needs('(foo|bar)bazqux')).toEqual(['bazqux']);
    expect(needs('(foobar|bazqux)ab')).toEqual(['bazqux', 'foobar']);
  });

  it('drops a literal that contains another of the list', () => {
    expect(needs('ignore|ignored|ign')).toEqual(['ign']);
  });

  it('passes through nested groups', () => {
    expect(needs('((ab)|(cd))efgh')).toEqual(['efgh']);
    expect(needs('((abcd)|(efgh))x')).toEqual(['abcd', 'efgh']);
  });

  it('has nothing when the list would be longer than it is worth', () => {
    const many = Array.from({ length: 80 }, (_, i) => `word${String(i).padStart(2, '0')}`);
    expect(needs(many.join('|'))).toBeNull();
  });
});

describe('requiredLiterals: escapes', () => {
  it('reads the control escapes', () => {
    expect(needs('a\\tb\\nc\\vd\\fe\\rf')).toEqual(['a\tb\nc\x0bd\x0ce\rf']);
  });

  it('reads hex and unicode escapes', () => {
    expect(needs('\\x41bc')).toEqual(['Abc']);
    expect(needs('\\u0041bc')).toEqual(['Abc']);
    expect(needs('\\x27ab\\x27')).toEqual(["'ab'"]);
    expect(needs('\\u{41}bc', 'u')).toEqual(['Abc']);
    expect(needs('a\\0b')).toEqual(['a\0b']);
  });

  it('joins a surrogate pair of escapes into the one character, with or without the u flag', () => {
    expect(needs('\\uD83D\\uDE00x', 'u')).toEqual(['\u{1F600}x']);
    expect(needs('\\uD83D\\uDE00x')).toEqual(['\u{1F600}x']);
    expect(needs('\\u{1F600}x', 'u')).toEqual(['\u{1F600}x']);
  });

  it('applies a quantifier to the whole character with u and to its last half without', () => {
    expect(needs('\u{1F600}?abc', 'u')).toEqual(['abc']);
    expect(needs('\u{1F600}+ab', 'u')).toEqual(['\u{1F600}']);
    // Without `u` the quantifier binds to the low half only; the run still holds the pair.
    expect(needs('\u{1F600}?abcd')).toEqual(['abcd']);
    expect(needs('\u{1F600}+ab')).toEqual(['\u{1F600}']);
  });

  it('reads an escaped metacharacter as itself', () => {
    expect(needs('a\\.b\\*c\\+d\\?e\\(f\\)g\\[h\\]i\\{j\\}k\\|l\\^m\\$n\\\\o\\/p')).toEqual([
      'a.b*c+d?e(f)g[h]i{j}k|l^m$n\\o/p',
    ]);
    expect(needs('a\\-b\\"c\\\'d\\ e')).toEqual(['a-b"c\'d e']);
  });

  it('reads a slash in the source the way RegExp prints it', () => {
    expect(needs(new RegExp('/etc/passwd').source)).toEqual(['/etc/passwd']);
    expect(needs(new RegExp('line1\nline2').source)).toEqual(['line1\nline2']);
  });

  it('treats the class escapes as classes', () => {
    expect(needs('abc\\dxyz\\Wuvw\\Sq')).toEqual(['abc']);
  });

  it('gives up on an escape it cannot be sure of', () => {
    for (const source of [
      '(a)\\1bcd',
      '\\12',
      'a\\08',
      '\\cJabc',
      '\\k<n>abc',
      '\\p{L}abc',
      '\\P{L}abc',
      '\\zabc',
      '\\hello',
      '\\xZZabc',
      '\\u12zzabc',
      '\\uZZZZabc',
    ])
      expect(needs(source), source).toBeNull();
  });

  it('gives up on a lone surrogate under the u flag', () => {
    expect(needs('\\uD83Dabc', 'u')).toBeNull();
    expect(needs('\\u{D83D}abc', 'u')).toBeNull();
  });
});

describe('requiredLiterals: syntax it will not guess at', () => {
  it('gives up on a named group, a modifier group and the v flag', () => {
    expect(needs('(?<n>abc)')).toBeNull();
    expect(needs('(?i:abc)')).toBeNull();
    expect(needs('abc', 'v')).toBeNull();
  });

  it('gives up on unbalanced input', () => {
    expect(needs('abc)def')).toBeNull();
    expect(needs('(abc')).toBeNull();
    expect(needs('[abc')).toBeNull();
    expect(needs('abc\\')).toBeNull();
    expect(needs('*abc')).toBeNull();
  });

  it('does not run out of stack on deeply nested input', () => {
    const source = `${'('.repeat(50_000)}a${')'.repeat(50_000)}`;
    expect(requiredLiterals(source, '')).toBeNull();
  });
});

describe('requiredLiterals: real shapes from the rule set', () => {
  it('reads a long alternation with an optional group', () => {
    const source =
      '\\b(ignore|disregard|forget|override)\\s+(all\\s+|any\\s+|the\\s+|your\\s+)?(previous|prior|above|earlier|preceding|system|original)\\s+(instructions?|prompts?|rules?|guidelines?|directives?)';
    expect(needs(source, 'i')).toEqual(['disregard', 'forget', 'ignore', 'override']);
  });

  it('reads a pattern that opens with a class', () => {
    const source =
      '[\\u202A\\u202B\\u202C].{1,100}(ignore|override|system|instruction|execute|reveal)';
    expect(needs(source)).toEqual([
      'execute',
      'ignore',
      'instruction',
      'override',
      'reveal',
      'system',
    ]);
  });

  it('reads non-Latin literals', () => {
    expect(needs('(проигнорируй|игнорируй)\\s+все')).toEqual(['игнорируй']);
  });
});
