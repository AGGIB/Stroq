import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../../src/harden/diff.js';
import { diff, lines, numbers } from './diff-apply.js';

/**
 * Every expected output below was produced by the system `diff -u` on the same two texts (the
 * header labels aside), so the format is the standard one and not this file's idea of it.
 */
describe('unifiedDiff: golden outputs', () => {
  it('shows a line added at the end', () => {
    expect(diff(lines('one', 'two', 'three'), lines('one', 'two', 'three', 'four'))).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', ' one', ' two', ' three', '+four'),
    );
  });

  it('shows a line deleted from the middle', () => {
    expect(diff(lines('one', 'two', 'three', 'four'), lines('one', 'two', 'four'))).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -1,4 +1,3 @@', ' one', ' two', '-three', ' four'),
    );
  });

  it('shows a replaced line as a deletion and an addition', () => {
    expect(diff(lines('one', 'two', 'three'), lines('one', 'TWO', 'three'))).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'),
    );
  });

  it('writes a range of one line without a count', () => {
    expect(diff(lines('one'), lines('ONE'))).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -1 +1 @@', '-one', '+ONE'),
    );
  });

  it('says so when the newline at the end of the file is added', () => {
    expect(diff('one\ntwo', 'one\ntwo\n')).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '\\ No newline at end of file',
        '+two',
      ),
    );
  });

  it('says so when the newline at the end of the file is removed', () => {
    expect(diff('one\ntwo\n', 'one\ntwo')).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '+two',
        '\\ No newline at end of file',
      ),
    );
  });

  it('marks both sides when neither has the newline', () => {
    expect(diff('one\ntwo', 'one\nTWO')).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        ' one',
        '-two',
        '\\ No newline at end of file',
        '+TWO',
        '\\ No newline at end of file',
      ),
    );
  });

  it('does not mark an unchanged last line that lacks its newline on both sides', () => {
    expect(diff('one\ntwo', 'ONE\ntwo')).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        '-one',
        '+ONE',
        ' two',
        '\\ No newline at end of file',
      ),
    );
  });

  describe('when one side is empty', () => {
    it('shows everything as added when a is empty', () => {
      expect(diff('', lines('one', 'two'))).toBe(
        lines('--- a/f.txt', '+++ b/f.txt', '@@ -0,0 +1,2 @@', '+one', '+two'),
      );
      expect(diff('', lines('one'))).toBe(
        lines('--- a/f.txt', '+++ b/f.txt', '@@ -0,0 +1 @@', '+one'),
      );
    });

    it('shows everything as removed when b is empty', () => {
      expect(diff(lines('one', 'two'), '')).toBe(
        lines('--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +0,0 @@', '-one', '-two'),
      );
      expect(diff(lines('one'), '')).toBe(
        lines('--- a/f.txt', '+++ b/f.txt', '@@ -1 +0,0 @@', '-one'),
      );
    });
  });

  it('keeps a carriage return as part of the line, as diff does', () => {
    expect(diff('a\r\nb\r\n', 'a\r\nc\r\n')).toBe(
      '--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n',
    );
  });

  it('shows an insertion after the first line with its context', () => {
    expect(diff(lines('a', 'b', 'c'), lines('a', 'X', 'b', 'c'))).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -1,3 +1,4 @@', ' a', '+X', ' b', ' c'),
    );
  });

  it('shows the growth of a JSON file the way a person reads it', () => {
    const before = '{\n  "a": 1\n}\n';
    const after = '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n';
    expect(diff(before, after)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,3 +1,6 @@',
        ' {',
        '-  "a": 1',
        '+  "a": 1,',
        '+  "b": [',
        '+    2',
        '+  ]',
        ' }',
      ),
    );
  });

  it('is empty when nothing differs', () => {
    expect(diff(lines('a', 'b'), lines('a', 'b'))).toBe('');
    expect(diff('', '')).toBe('');
    expect(diff('no newline', 'no newline')).toBe('');
  });
});

describe('unifiedDiff: hunks and context', () => {
  it('keeps changes in separate hunks when more than twice the context lies between them', () => {
    const a = lines(...numbers(1, 15));
    const b = lines('1', '2', 'THREE', ...numbers(4, 13), 'FOURTEEN', '15');
    expect(diff(a, b)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,6 +1,6 @@',
        ' 1',
        ' 2',
        '-3',
        '+THREE',
        ' 4',
        ' 5',
        ' 6',
        '@@ -11,5 +11,5 @@',
        ' 11',
        ' 12',
        ' 13',
        '-14',
        '+FOURTEEN',
        ' 15',
      ),
    );
  });

  it('joins two changes into one hunk when exactly twice the context lies between them', () => {
    const a = lines(...numbers(1, 10));
    const b = lines('1', 'TWO', ...numbers(3, 8), 'NINE', '10');
    expect(diff(a, b)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,10 +1,10 @@',
        ' 1',
        '-2',
        '+TWO',
        ' 3',
        ' 4',
        ' 5',
        ' 6',
        ' 7',
        ' 8',
        '-9',
        '+NINE',
        ' 10',
      ),
    );
  });

  it('splits them when one more line lies between', () => {
    const a = lines(...numbers(1, 11));
    const b = lines('1', 'TWO', ...numbers(3, 9), 'TEN', '11');
    expect(diff(a, b)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,5 +1,5 @@',
        ' 1',
        '-2',
        '+TWO',
        ' 3',
        ' 4',
        ' 5',
        '@@ -7,5 +7,5 @@',
        ' 7',
        ' 8',
        ' 9',
        '-10',
        '+TEN',
        ' 11',
      ),
    );
  });

  it('takes the number of context lines from the options', () => {
    const a = lines(...numbers(1, 11));
    const b = lines('1', 'TWO', ...numbers(3, 9), 'TEN', '11');
    expect(diff(a, b, 1)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,3 +1,3 @@',
        ' 1',
        '-2',
        '+TWO',
        ' 3',
        '@@ -9,3 +9,3 @@',
        ' 9',
        '-10',
        '+TEN',
        ' 11',
      ),
    );
    expect(diff(a, b, 0)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -2 +2 @@',
        '-2',
        '+TWO',
        '@@ -10 +10 @@',
        '-10',
        '+TEN',
      ),
    );
  });

  it('numbers an empty range by the line before it', () => {
    expect(diff(lines('a', 'b', 'c'), lines('a', 'b', 'X', 'c'), 0)).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -2,0 +3 @@', '+X'),
    );
    expect(diff(lines('a', 'b', 'c'), lines('a', 'c'), 0)).toBe(
      lines('--- a/f.txt', '+++ b/f.txt', '@@ -2 +1,0 @@', '-b'),
    );
  });

  it('puts changes at the very start and the very end in one hunk when the context reaches', () => {
    const a = lines('a', 'b', 'c', 'd', 'e');
    const b = lines('A', 'b', 'c', 'd', 'E');
    expect(diff(a, b)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,5 +1,5 @@',
        '-a',
        '+A',
        ' b',
        ' c',
        ' d',
        '-e',
        '+E',
      ),
    );
    expect(diff(a, b, 1)).toBe(
      lines(
        '--- a/f.txt',
        '+++ b/f.txt',
        '@@ -1,2 +1,2 @@',
        '-a',
        '+A',
        ' b',
        '@@ -4,2 +4,2 @@',
        ' d',
        '-e',
        '+E',
      ),
    );
  });
});

describe('unifiedDiff: headers', () => {
  it('names a file that did not exist /dev/null on the old side', () => {
    expect(unifiedDiff('', lines('x'), { path: 'f.txt', oldMissing: true })).toBe(
      lines('--- /dev/null', '+++ b/f.txt', '@@ -0,0 +1 @@', '+x'),
    );
  });

  it('names a file that is gone /dev/null on the new side', () => {
    expect(unifiedDiff(lines('x'), '', { path: 'f.txt', newMissing: true })).toBe(
      lines('--- a/f.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'),
    );
  });

  it('still shows the headers for a file that is created empty', () => {
    expect(unifiedDiff('', '', { path: 'f.txt', oldMissing: true })).toBe(
      lines('--- /dev/null', '+++ b/f.txt'),
    );
  });

  // An absolute path would read `a//home/me/...`; a path is a label here, not a place to open.
  it('writes an absolute path without its leading slash, and backslashes as slashes', () => {
    const header = unifiedDiff('a\n', 'b\n', { path: '/home/me/.claude/settings.json' }).split(
      '\n',
    );
    expect(header.slice(0, 2)).toEqual([
      '--- a/home/me/.claude/settings.json',
      '+++ b/home/me/.claude/settings.json',
    ]);
    const windows = unifiedDiff('a\n', 'b\n', { path: 'C:\\Users\\me\\settings.json' }).split('\n');
    expect(windows[0]).toBe('--- a/C:/Users/me/settings.json');
  });

  // The path can come from a directory listing. A newline in it must not make a line of the diff.
  it('cannot be made to print an extra line by a path with control characters in it', () => {
    const out = unifiedDiff('a\n', 'b\n', { path: 'x\n+++ b/evil\u001b[31m' });
    expect(out.split('\n').filter((row) => row.startsWith('+++'))).toHaveLength(1);
    expect(out).not.toContain('\u001b');
  });
});
