import { describe, expect, it } from 'vitest';
import { showable, showableWhere } from '../../../src/install/inspect/safe-text.js';
import { PassportLineSchema } from '../../../src/install/types.js';
import { cpuNow } from '../../helpers/cpu-time.js';

const asLine = (subject: string) =>
  PassportLineSchema.safeParse({
    kind: 'exec',
    subject,
    basis: 'observed',
    sensitive: false,
    where: [],
    detector: 'x',
  });

describe('showable', () => {
  it('leaves ordinary text as it is', () => {
    expect(showable('npm run build', 100)).toBe('npm run build');
  });

  it('writes out the escape that starts a terminal sequence', () => {
    const text = showable('a\u001b[31mred\u001b[0m', 100);

    expect(text).not.toContain('\u001b');
    expect(text).toContain('\\u001b');
  });

  it.each([
    ['a zero-width space', 'a\u200bb'],
    ['a direction override', 'a\u202eb'],
    ['a soft hyphen', 'a\u00adb'],
    ['a byte order mark', 'a\ufeffb'],
    ['a tag character', 'a\u{e0041}b'],
    ['a line separator', 'a\u2028b'],
    ['a lone surrogate', 'a\ud800b'],
    ['a replacement character', 'a\ufffdb'],
    ['NUL', 'a\u0000b'],
    ['a C1 control', 'a\u009bb'],
  ])('makes %s visible, so the schema accepts it', (_what, input) => {
    const text = showable(input, 100);

    expect(asLine(text).success).toBe(true);
    expect(text).not.toBe(input);
  });

  it('folds a newline and a tab, and runs of blanks, into single spaces', () => {
    expect(showable('a\n\n  b\t\tc\r\nd', 100)).toBe('a b c d');
  });

  it('cuts to the length given and marks the cut', () => {
    const text = showable('x'.repeat(500), 20);

    expect(Array.from(text)).toHaveLength(20);
    expect(text.endsWith('\u2026')).toBe(true);
  });

  it('does not cut text of exactly the length given', () => {
    expect(showable('x'.repeat(20), 20)).toBe('x'.repeat(20));
  });

  it('does not split an astral character when it cuts', () => {
    const text = showable('\u{1f600}'.repeat(50), 10);

    expect(Array.from(text)).toHaveLength(10);
    expect(text.includes('\ud83d\u2026')).toBe(false);
  });

  it('trims the blanks at either end', () => {
    expect(showable('   padded   ', 100)).toBe('padded');
  });

  it('answers a megabyte of text in a time that does not depend on its length', () => {
    const big = 'a\u202e'.repeat(512 * 1024);
    const started = cpuNow();

    const text = showable(big, 100);

    expect(Array.from(text).length).toBeLessThanOrEqual(100);
    expect(cpuNow() - started).toBeLessThan(200);
  });
});

describe('showableWhere', () => {
  it('keeps a path of the tree and a line number', () => {
    expect(showableWhere('lib/a.js', 12)).toEqual({ file: 'lib/a.js', line: 12 });
  });

  it('accepts no line', () => {
    expect(showableWhere('SKILL.md', null)).toEqual({ file: 'SKILL.md', line: null });
  });

  it('turns a line that is not a positive whole number into no line', () => {
    expect(showableWhere('a', 0).line).toBeNull();
    expect(showableWhere('a', -3).line).toBeNull();
    expect(showableWhere('a', 1.5).line).toBeNull();
    expect(showableWhere('a', Number.NaN).line).toBeNull();
  });

  it('writes out what a path of a tree could not hold anyway', () => {
    expect(showableWhere('a\u001bb', 1).file).not.toContain('\u001b');
  });
});
