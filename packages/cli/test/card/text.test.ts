import { describe, expect, it } from 'vitest';
import { clean, cut, num, plural, shortPath, tilde, wrap } from '../../src/card/text.js';

describe('numbers and words', () => {
  it('writes thousands with commas and chooses the singular', () => {
    expect(num(31_785)).toBe('31,785');
    expect(plural(1, 'key', 'keys')).toBe('1 key');
    expect(plural(0, 'key', 'keys')).toBe('0 keys');
    expect(plural(2_000, 'key', 'keys')).toBe('2,000 keys');
  });
});

describe('clean: text from outside as one safe line', () => {
  it('writes every control character out and folds blanks', () => {
    expect(clean('a\u001b]52;c;Zm9v\u0007  b\n\tc')).toBe('a\\u001b]52;c;Zm9v\\u0007 b c');
    expect(clean('x‮y')).toBe('x\\u202ey');
  });

  it('is the same when applied twice', () => {
    const once = clean('a\u001b[2Kb');
    expect(clean(once)).toBe(once);
  });

  it('cuts to a length with an ellipsis', () => {
    expect(clean('abcdefghij', 5)).toBe('abcd…');
    expect(cut('abc', 5)).toBe('abc');
  });
});

describe('paths', () => {
  it('writes home as ~ only for a path inside it', () => {
    expect(tilde('/Users/dev/shop', '/Users/dev')).toBe('~/shop');
    expect(tilde('/Users/dev', '/Users/dev')).toBe('~');
    expect(tilde('/Users/devil/shop', '/Users/dev')).toBe('/Users/devil/shop');
    expect(tilde('/srv/app', '')).toBe('/srv/app');
  });

  it('shortens Windows paths under home regardless of separator or case', () => {
    const home = 'C:\\Users\\Dev';
    expect(tilde('c:\\users\\dev', home)).toBe('~');
    expect(tilde('c:/Users/dev\\shop\\src', home)).toBe('~/shop/src');
    expect(tilde('C:\\Users\\Devil\\shop', home)).toBe('C:\\Users\\Devil\\shop');
    expect(tilde('D:\\Users\\Dev\\shop', home)).toBe('D:\\Users\\Dev\\shop');
    expect(tilde('C:\\Users\\Dev\\..', home)).toBe('C:\\Users\\Dev\\..');
    expect(tilde('C:shop', home)).toBe('C:shop');
    expect(tilde('C:\\Users\\Dev\\shop', `${home}\\`)).toBe('~/shop');
    expect(tilde('//host/share/dev/shop', '\\\\host\\share\\Dev')).toBe('~/shop');
  });

  it('keeps backslashes as filename characters in POSIX paths', () => {
    expect(tilde('/Users/dev\\shop', '/Users/dev')).toBe('/Users/dev\\shop');
    expect(tilde('/Users/dev/shop\\src', '/Users/dev')).toBe('~/shop\\src');
  });

  it('cuts the middle out of a long path', () => {
    const shown = shortPath(
      '/Users/dev/very/long/folder/names/that/go/on/and/on/forever/app',
      '/Users/dev',
      30,
    );
    expect([...shown].length).toBeLessThanOrEqual(30);
    expect(shown).toContain('…');
    expect(shown.startsWith('~/')).toBe(true);
  });

  it('makes a hostile path safe', () => {
    expect(shortPath('/w/\u001b[31mred', '/Users/dev')).toBe('/w/\\u001b[31mred');
  });
});

describe('wrap', () => {
  it('wraps at the width and hangs the text under itself', () => {
    expect(wrap('one two three four five six', 14, '1  ')).toEqual([
      '1  one two',
      '   three four',
      '   five six',
    ]);
  });

  it('puts a word longer than a line on a line of its own, cut to fit', () => {
    const lines = wrap(`a ${'x'.repeat(100)} b`, 20, '> ');
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(20);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('gives one line for no words', () => {
    expect(wrap('', 20, '> ')).toEqual(['>']);
  });
});
