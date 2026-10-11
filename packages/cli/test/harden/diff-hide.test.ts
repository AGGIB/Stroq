import { describe, expect, it } from 'vitest';
import { HIDDEN_LINE, diffText, unifiedDiff, type HideLine } from '../../src/harden/diff.js';
import { lines } from './diff-apply.js';

const options = { path: 'f.txt' } as const;
const rowsOf = (text: string): string[] => text.split('\n').filter((row) => row !== '');

describe('diffText: lines it is asked to hide', () => {
  const old = lines('a', 'b', 'c', 'd', 'e', 'f', 'g');
  const next = lines('a', 'b', 'c', 'D', 'e', 'f', 'g');

  it('shows a hidden line as the placeholder, and keeps the shape of the diff', () => {
    const plain = unifiedDiff(old, next, options);
    const hideC: HideLine = (_index, line) => line === 'c';

    const hidden = diffText(old, next, { ...options, hide: { old: hideC, new: hideC } });

    expect(hidden.hidden).toBe(1);
    expect(rowsOf(hidden.text)).toEqual(
      rowsOf(plain).map((row) => (row === ' c' ? ` ${HIDDEN_LINE}` : row)),
    );
    expect(hidden.text).not.toMatch(/^ c$/m);
  });

  it('hides a changed line on the side that is asked, and leaves the other side alone', () => {
    const hideNew: HideLine = (_index, line) => line === 'D';

    const result = diffText(old, next, { ...options, hide: { new: hideNew } });

    expect(rowsOf(result.text)).toContain('-d');
    expect(rowsOf(result.text)).toContain(`+${HIDDEN_LINE}`);
    expect(rowsOf(result.text)).not.toContain('+D');
  });

  it('hides a context line when either side asks for it', () => {
    const onlyOld: HideLine = (_index, line) => line === 'e';
    const onlyNew: HideLine = (_index, line) => line === 'b';

    const result = diffText(old, next, { ...options, hide: { old: onlyOld, new: onlyNew } });

    expect(rowsOf(result.text)).toContain(` ${HIDDEN_LINE}`);
    expect(rowsOf(result.text)).not.toContain(' e');
    expect(rowsOf(result.text)).not.toContain(' b');
    expect(result.hidden).toBe(2);
  });

  it('numbers lines from 0 in the text each side belongs to, and gives the line without its break', () => {
    const asked: string[] = [];
    const spy =
      (side: string): HideLine =>
      (index, line) => {
        asked.push(`${side}${index}:${line}`);
        return false;
      };

    diffText(lines('x', 'y', 'z'), lines('x', 'Y', 'z'), {
      ...options,
      hide: { old: spy('old'), new: spy('new') },
    });

    // The line shared by both is asked about on the side it belongs to; each side counts its own lines.
    expect(asked).toContain('old0:x');
    expect(asked).toContain('old1:y');
    expect(asked).toContain('new1:Y');
    expect(asked).toContain('new2:z');
    expect(asked.every((entry) => !entry.includes('\n'))).toBe(true);
  });

  it('gives the line without a carriage return', () => {
    const seen: string[] = [];

    diffText('a\r\nb\r\n', 'a\r\nc\r\n', {
      ...options,
      hide: {
        old: (_i, line) => (seen.push(line), false),
        new: (_i, line) => (seen.push(line), false),
      },
    });

    expect(seen.some((line) => line.includes('\r'))).toBe(false);
  });

  it('asks only about lines that appear in the diff, not the whole file', () => {
    const big = lines(...Array.from({ length: 2_000 }, (_, i) => `line ${i}`));
    const changed = big.replace('line 1000\n', 'line 1000 changed\n');
    let asked = 0;
    const count: HideLine = () => (asked++, false);

    diffText(big, changed, { ...options, hide: { old: count, new: count } });

    expect(asked).toBeLessThan(40);
  });

  it('keeps the marker for a last line with no line break, and hides that line too', () => {
    const result = diffText('a\nsecret', 'a\nsecret2', {
      ...options,
      hide: {
        old: (_i, line) => line.startsWith('secret'),
        new: (_i, line) => line.startsWith('secret'),
      },
    });

    expect(rowsOf(result.text)).toEqual([
      '--- a/f.txt',
      '+++ b/f.txt',
      '@@ -1,2 +1,2 @@',
      ' a',
      `-${HIDDEN_LINE}`,
      '\\ No newline at end of file',
      `+${HIDDEN_LINE}`,
      '\\ No newline at end of file',
    ]);
  });

  it('is the diff it always was when it hides nothing', () => {
    const never: HideLine = () => false;

    expect(diffText(old, next, { ...options, hide: { old: never, new: never } })).toEqual({
      text: unifiedDiff(old, next, options),
      hidden: 0,
    });
  });
});
