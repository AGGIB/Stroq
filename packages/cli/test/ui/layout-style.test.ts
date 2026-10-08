import { describe, expect, it } from 'vitest';
import {
  keepWhole,
  outside,
  row,
  shortPath,
  unbreakable,
  widest,
  wrap,
  wrapKeeping,
} from '../../src/ui/layout.js';
import { styleFor, visibleLength, type Style } from '../../src/ui/style.js';
import { symbolsFor } from '../../src/ui/symbols.js';

const ESC = '\u001b';
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const withoutSgr = (text: string): string => text.replace(SGR, '');

const NAMES = [
  'bold',
  'dim',
  'accent',
  'good',
  'bad',
  'warn',
] as const satisfies readonly (keyof Style)[];
const SAMPLES = ['stroq', '', 'two words', '✔ done', 'Ааронов 你好 🙂', 'x'.repeat(200)];

describe('visibleLength', () => {
  it('is the length of plain text', () => {
    expect(visibleLength('stroq')).toBe(5);
    expect(visibleLength('')).toBe(0);
  });

  it('ignores colour sequences, however many parameters they have', () => {
    expect(visibleLength(`${ESC}[1mbold${ESC}[22m`)).toBe(4);
    expect(visibleLength(`${ESC}[38;5;208morange${ESC}[39m`)).toBe(6);
    expect(visibleLength(`${ESC}[1;38;5;208mboth${ESC}[0m`)).toBe(4);
  });

  it('counts a character outside the first plane once', () => {
    expect(visibleLength('a🙂b')).toBe(3);
  });

  it('counts the glyphs a screen draws as one column each', () => {
    expect(visibleLength('✔ ✘ – ⠋')).toBe(7);
  });
});

describe('styleFor', () => {
  describe('with colour off', () => {
    it.each(NAMES)('%s returns its argument as it came', (name) => {
      const off = styleFor({ color: false, color256: false });
      const offWith256 = styleFor({ color: false, color256: true });

      for (const text of SAMPLES) {
        expect(off[name](text)).toBe(text);
        expect(offWith256[name](text)).toBe(text);
      }
    });
  });

  describe('with colour on', () => {
    it('colours the accent orange where there are 256 colours', () => {
      const style = styleFor({ color: true, color256: true });

      expect(style.accent('x')).toBe(`${ESC}[38;5;208mx${ESC}[39m`);
    });

    it('colours the accent yellow where there are 8 colours', () => {
      const style = styleFor({ color: true, color256: false });

      expect(style.accent('x')).toBe(`${ESC}[33mx${ESC}[39m`);
    });

    it.each([
      ['bold', '1', '22'],
      ['dim', '2', '22'],
      ['good', '32', '39'],
      ['bad', '31', '39'],
      ['warn', '33', '39'],
    ] as const)(
      'writes %s as %s and ends it with %s, with or without 256 colours',
      (name, on, off) => {
        for (const color256 of [false, true]) {
          const style = styleFor({ color: true, color256 });

          expect(style[name]('x')).toBe(`${ESC}[${on}mx${ESC}[${off}m`);
        }
      },
    );

    it.each(NAMES)('%s leaves the text as it was between its sequences', (name) => {
      for (const color256 of [false, true]) {
        const style = styleFor({ color: true, color256 });

        for (const text of SAMPLES) expect(withoutSgr(style[name](text))).toBe(text);
      }
    });

    it.each(NAMES)('%s measures as the plain text does', (name) => {
      for (const color256 of [false, true]) {
        const style = styleFor({ color: true, color256 });

        for (const text of SAMPLES)
          expect(visibleLength(style[name](text))).toBe(visibleLength(text));
      }
    });

    it('measures nested styles as the plain text does', () => {
      const style = styleFor({ color: true, color256: true });

      expect(visibleLength(style.bold(style.accent('nested')))).toBe(6);
    });

    it('gives the same answer every time', () => {
      const style = styleFor({ color: true, color256: true });

      expect(style.good('x')).toBe(style.good('x'));
    });
  });
});

describe('wrap', () => {
  const SENTENCE =
    'Stroq judges every command, file edit and tool call your agent makes, on this machine, before it runs.';

  it('has no lines for empty or blank text', () => {
    expect(wrap('', 10)).toEqual([]);
    expect(wrap('   \n\t ', 10)).toEqual([]);
  });

  it('keeps text that fits on one line', () => {
    expect(wrap('a short line', 80)).toEqual(['a short line']);
  });

  it('fills a line to exactly the width and no further', () => {
    expect(wrap('abcde fghij', 11)).toEqual(['abcde fghij']);
    expect(wrap('abcde fghij', 10)).toEqual(['abcde', 'fghij']);
  });

  it.each([10, 15, 20, 30, 40])('keeps every line within %i columns', (width) => {
    const lines = wrap(SENTENCE, width);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(width);
  });

  it.each([10, 20, 30])('loses no word and reorders none at width %i', (width) => {
    const lines = wrap(SENTENCE, width);

    expect(lines.join(' ').split(/\s+/)).toEqual(SENTENCE.split(/\s+/));
  });

  it('indents every line after the first by the hang, and counts the hang in the width', () => {
    const lines = wrap(SENTENCE, 30, 4);

    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]?.startsWith(' ')).toBe(false);
    for (const line of lines.slice(1)) expect(line.startsWith('    ')).toBe(true);
    for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(30);
  });

  it('does not indent a text that fits on its first line', () => {
    expect(wrap('fits', 20, 6)).toEqual(['fits']);
  });

  it('keeps a word that is longer than the width whole, on a line of its own', () => {
    expect(wrap('supercalifragilistic', 5)).toEqual(['supercalifragilistic']);
    expect(wrap('a supercalifragilistic b', 5)).toEqual(['a', 'supercalifragilistic', 'b']);
  });

  it('puts one word on each line when the width is too small for two', () => {
    expect(wrap('a b c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('collapses every run of whitespace, tabs and newlines into one space', () => {
    expect(wrap('  a \t b\n\nc  ', 80)).toEqual(['a b c']);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(wrap('🙂🙂 🙂🙂', 5)).toEqual(['🙂🙂 🙂🙂']);
    expect(wrap('🙂🙂 🙂🙂', 4)).toEqual(['🙂🙂', '🙂🙂']);
  });
});

describe('shortPath', () => {
  const LONG = '/Users/someone/projects/app/.claude/settings.json';

  it('leaves a path that fits as it is', () => {
    expect(shortPath('/a/b', 10)).toBe('/a/b');
    expect(shortPath('/a/b', 4)).toBe('/a/b');
  });

  it('leaves an empty path as it is', () => {
    expect(shortPath('', 5)).toBe('');
  });

  it.each([10, 20, 25, 40])(
    'cuts a long path to exactly %i characters, from the front',
    (width) => {
      const short = shortPath(LONG, width);

      expect([...short]).toHaveLength(width);
      expect(short.startsWith('…')).toBe(true);
    },
  );

  it('keeps the end of the path, because the end names the file', () => {
    const short = shortPath(LONG, 25);

    expect(LONG.endsWith(short.slice(1))).toBe(true);
    expect(short.endsWith('settings.json')).toBe(true);
  });

  it('cuts a path that is one character too long', () => {
    expect(shortPath('abcdef', 5)).toBe('…cdef');
  });

  it('shows only the ellipsis in a width of one', () => {
    expect(shortPath('abcdef', 1)).toBe('…');
  });

  it('counts characters, not UTF-16 units', () => {
    expect(shortPath('🙂🙂🙂🙂🙂🙂', 4)).toBe('…🙂🙂🙂');
  });
});

describe('row', () => {
  it('pads the label to the label width and puts the value after it', () => {
    expect(row('ab', 'x', 5)).toBe('ab   x');
  });

  it('keeps one space after a label that is exactly as wide as the column', () => {
    expect(row('abc', 'x', 3)).toBe('abc x');
  });

  it('keeps one space after a label that is wider than the column', () => {
    expect(row('abcdef', 'x', 3)).toBe('abcdef x');
  });

  it('pads an empty label to the column', () => {
    expect(row('', 'v', 4)).toBe('    v');
  });

  it('measures the label as it is seen, without its colour', () => {
    const accent = styleFor({ color: true, color256: true }).accent;

    const line = row(accent('ab'), 'x', 5);

    expect(line).toBe(`${accent('ab')}   x`);
    expect(withoutSgr(line)).toBe('ab   x');
  });

  it('leaves the value as it is', () => {
    const dim = styleFor({ color: true, color256: false }).dim;

    expect(row('a', dim('v'), 2)).toBe(`a ${dim('v')}`);
  });
});

describe('widest', () => {
  it('is 0 for no lines', () => {
    expect(widest([])).toBe(0);
  });

  it('is the length of the longest line', () => {
    expect(widest(['a', 'abc', 'ab'])).toBe(3);
  });

  it('measures the lines as they are seen, without their colour', () => {
    const accent = styleFor({ color: true, color256: true }).accent;

    expect(widest([accent('abcd'), 'abc'])).toBe(4);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(widest(['🙂🙂', 'abc'])).toBe(3);
  });
});

describe('outside', () => {
  it('writes ESC out as a visible escape, so that none is left', () => {
    const shown = outside(`a${ESC}[2Kb`);

    expect(shown).toBe('a\\u001b[2Kb');
    expect(shown).not.toContain(ESC);
  });

  it('keeps the text around a sequence readable', () => {
    const shown = outside(`before ${ESC}[31mred${ESC}[0m after`);

    expect(shown).toContain('before ');
    expect(shown).toContain('red');
    expect(shown).toContain(' after');
    expect(shown).not.toContain(ESC);
  });

  it.each([
    ['carriage return', '\r', '\\u000d'],
    ['bell', '\u0007', '\\u0007'],
    ['backspace', '\b', '\\u0008'],
    ['null', '\u0000', '\\u0000'],
    ['delete', '\u007f', '\\u007f'],
    ['CSI as one byte', '\u009b', '\\u009b'],
    ['left-to-right embedding', '‪', '\\u202a'],
    ['right-to-left override', '‮', '\\u202e'],
    ['left-to-right isolate', '⁦', '\\u2066'],
    ['pop directional isolate', '⁩', '\\u2069'],
  ])('writes out a %s', (_name, char, shown) => {
    expect(outside(`x${char}y`)).toBe(`x${shown}y`);
  });

  it('cannot be made to show a file name backwards', () => {
    expect(outside('evil‮txt.sh')).not.toContain('‮');
  });

  it('leaves tabs, newlines and text in any script alone', () => {
    const text = 'Ааронов\tрешил ✔ 你好 🙂\nnext line';

    expect(outside(text)).toBe(text);
  });
});

describe('symbolsFor', () => {
  const drawn = symbolsFor(true);
  const plain = symbolsFor(false);
  const textsOf = (set: ReturnType<typeof symbolsFor>): string[] => [
    set.ok,
    set.bad,
    set.none,
    set.dot,
    set.arrow,
    set.ask,
    ...set.frames,
  ];

  it('draws the glyphs where the terminal can', () => {
    expect(drawn).toMatchObject({ ok: '✔', bad: '✘', none: '–', dot: '·', arrow: '→' });
  });

  it('has no character outside printable ASCII in the plain set', () => {
    for (const text of textsOf(plain)) expect(text).toMatch(/^[\x20-\x7e]+$/);
  });

  it('has non-ASCII glyphs in the drawn set, which is why there is a plain one', () => {
    expect(textsOf(drawn).some((text) => /[^\x20-\x7e]/.test(text))).toBe(true);
  });

  it('has the same members in both sets', () => {
    expect(Object.keys(plain).sort()).toEqual(Object.keys(drawn).sort());
  });

  it.each([
    ['drawn', drawn],
    ['plain', plain],
  ])('has frames that are one column wide and all different in the %s set', (_name, set) => {
    expect(set.frames.length).toBeGreaterThan(1);
    expect(new Set(set.frames).size).toBe(set.frames.length);
    for (const frame of set.frames) expect([...frame]).toHaveLength(1);
  });

  it.each([
    ['drawn', drawn],
    ['plain', plain],
  ])('tells success, failure and nothing apart in the %s set', (_name, set) => {
    expect(new Set([set.ok, set.bad, set.none]).size).toBe(3);
  });
});

describe('wrapKeeping', () => {
  it('does not break a command in backticks, where wrap would', () => {
    const text = 'Run `npm install -g @stroq/cli` and then `stroq init` again, please.';

    expect(wrap(text, 24).some((line) => line.includes('`npm install -g @stroq/cli`'))).toBe(false);
    const lines = wrapKeeping(text, 24);

    expect(lines.some((line) => line.includes('`npm install -g @stroq/cli`'))).toBe(true);
    expect(lines.some((line) => line.includes('`stroq init`'))).toBe(true);
  });

  it('does not break a quoted command that begins with a program of ours', () => {
    const lines = wrapKeeping('Run "stroq init --agent windsurf --user" instead of this.', 20);

    expect(lines.some((line) => line.includes('"stroq init --agent windsurf --user"'))).toBe(true);
  });

  it('breaks a quotation that is not a command, as wrap does', () => {
    expect(wrapKeeping('He said "this is only some words in quotes" and left.', 20)).toEqual(
      wrap('He said "this is only some words in quotes" and left.', 20),
    );
  });

  it('keeps what a caller marked, in a command it built', () => {
    const lines = wrapKeeping(`undo ${unbreakable('stroq uninstall --agent cursor')} done`, 16);

    expect(lines).toContain('stroq uninstall --agent cursor');
  });

  it('puts the blanks back, and leaves no marker in what it returns', () => {
    const lines = wrapKeeping('a `b c` d '.repeat(20), 30);

    expect(lines.join('\n')).not.toContain('\u0001');
    expect(keepWhole('`b c`')).not.toContain(' ');
  });

  it('is wrap, for text with no command in it', () => {
    for (const text of ['', 'one two three', 'a'.repeat(100), 'ааа бббб ввв гггг']) {
      expect(wrapKeeping(text, 8, 2)).toEqual(wrap(text, 8, 2));
    }
  });
});
