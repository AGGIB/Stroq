import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkEntryPath } from '../../src/install/safe-path.js';
import { LIMITS } from '../../src/install/types.js';
import { escapeHtml, safe } from '../../src/replay/html.js';
import { neutralizeControls } from '../../src/terminal-safe.js';

// A path decides where a byte of somebody else's archive lands on a disk, so this table is the
// contract: every class of path that must never reach a filesystem, and the look-alikes that must.
// Each rejected row breaks one rule and names the reason it is refused for.

const REJECTED: readonly (readonly [what: string, path: string, reason: RegExp])[] = [
  ['an empty path', '', /empty path/],
  ['an empty component (a double slash)', 'a//b', /empty component/],
  ['a trailing slash', 'a/', /empty component/],
  ['a leading slash', '/etc/passwd', /absolute/],
  ['a lone slash', '/', /absolute/],
  ['a leading backslash', '\\share\\x', /absolute/],
  ['a backslash as a separator', 'a\\b', /backslash/],
  ['a backslash dot-dot', 'dir\\..\\x', /backslash/],
  ['a dot component', '.', /'\.' or '\.\.'/],
  ['a dot component in the middle', 'a/./b', /'\.' or '\.\.'/],
  ['a dot-dot component', '..', /'\.' or '\.\.'/],
  ['a leading dot-dot', '../a', /'\.' or '\.\.'/],
  ['a dot-dot in the middle', 'a/../b', /'\.' or '\.\.'/],
  ['a trailing dot-dot', 'a/..', /'\.' or '\.\.'/],
  ['a drive letter', 'C:/Windows/x', /drive letter/],
  ['a drive letter in lower case, drive-relative', 'c:x', /drive letter/],
  ['a drive letter alone', 'Z:', /drive letter/],
  ['a colon (an alternate data stream)', 'file.txt:stream', /':'/],
  ['a colon in a later component', 'a/b:c', /':'/],
  ['the .git stream trick', '.git::$INDEX_ALLOCATION', /':'/],

  ['a NUL', 'a\u0000b', /control character/],
  ['a newline', 'a\nb', /control character/],
  ['a tab', 'a\tb', /control character/],
  ['a carriage return', 'a\rb', /control character/],
  ['an escape (a terminal sequence)', 'a\u001b[2Jb', /control character/],
  ['the last C0 control', 'a\u001fb', /control character/],
  ['DEL', 'a\u007fb', /control character/],
  ['the first C1 control', 'a\u0080b', /control character/],
  ['NEL', 'a\u0085b', /control character/],
  ['an 8-bit CSI', 'a\u009bb', /control character/],
  ['the last C1 control', 'a\u009fb', /control character/],

  ['a right-to-left override', 'a\u202eb', /invisible or direction/],
  ['a left-to-right embedding', 'a\u202ab', /invisible or direction/],
  ['a pop of direction formatting', 'a\u202cb', /invisible or direction/],
  ['a left-to-right isolate', 'a\u2066b', /invisible or direction/],
  ['a right-to-left isolate', 'a\u2067b', /invisible or direction/],
  ['a first-strong isolate', 'a\u2068b', /invisible or direction/],
  ['a pop isolate', 'a\u2069b', /invisible or direction/],
  ['a zero-width space', 'a\u200bb', /invisible or direction/],
  ['a zero-width non-joiner', 'a\u200cb', /invisible or direction/],
  ['a zero-width joiner', 'a\u200db', /invisible or direction/],
  ['a left-to-right mark', 'a\u200eb', /invisible or direction/],
  ['a right-to-left mark', 'a\u200fb', /invisible or direction/],
  ['a line separator', 'a\u2028b', /invisible or direction/],
  ['a paragraph separator', 'a\u2029b', /invisible or direction/],
  ['a word joiner', 'a\u2060b', /invisible or direction/],
  ['an invisible times', 'a\u2062b', /invisible or direction/],
  ['a deprecated format character', 'a\u206ab', /invisible or direction/],
  ['the last deprecated format character', 'a\u206fb', /invisible or direction/],
  ['a Mongolian vowel separator', 'a\u180eb', /invisible or direction/],
  ['a variation selector', 'a\ufe0fb', /invisible or direction/],
  ['the first variation selector', 'a\ufe00b', /invisible or direction/],
  ['a byte order mark', 'a\ufeffb', /invisible or direction/],
  ['an interlinear annotation anchor', 'a\ufff9b', /invisible or direction/],
  ['an interlinear annotation terminator', 'a\ufffbb', /invisible or direction/],
  ['a tag letter', 'a\u{e0041}b', /invisible or direction/],
  ['the language tag', 'a\u{e0001}b', /invisible or direction/],
  ['the cancel tag', 'a\u{e007f}b', /invisible or direction/],
  ['a supplementary variation selector', 'a\u{e0100}b', /invisible or direction/],
  ['the last supplementary variation selector', 'a\u{e01ef}b', /invisible or direction/],

  ['bytes that were not UTF-8 (a replacement character)', 'a\ufffdb', /replacement character/],
  ['a lone high surrogate', 'a\ud800b', /valid Unicode/],
  ['a lone low surrogate', 'a\udc00b', /valid Unicode/],
  ['a high surrogate at the end', 'ab\ud83d', /valid Unicode/],

  ['.git', '.git', /\.git/],
  ['.git with something under it', '.git/config', /\.git/],
  ['.GIT in capitals', '.GIT/hooks/pre-commit', /\.git/],
  ['.Git in mixed case', 'x/.Git/y', /\.git/],
  ['.git as the last component', 'a/b/.git', /\.git/],
  ['the NTFS short name of .git', 'GIT~1', /\.git/],
  ['the short name in lower case, with a path under it', 'git~1/hooks/x', /\.git/],
  ['the short name in a later component', 'a/Git~1/b', /\.git/],
  ['another numbered short name', 'GIT~2', /\.git/],
  ['.git written with full-width characters', '\uff0e\uff47\uff49\uff54/x', /\.git/],

  ['a trailing dot', 'a.', /ending in a dot or a space/],
  ['a trailing space', 'a ', /ending in a dot or a space/],
  ['a trailing dot in a directory', 'dir./x', /ending in a dot or a space/],
  ['a trailing space in a directory', 'dir /x', /ending in a dot or a space/],
  ['a trailing dot and space', 'x/a. ', /ending in a dot or a space/],
  ['only dots', 'a/...', /ending in a dot or a space/],

  ['CON', 'CON', /Windows device name/],
  ['con in lower case', 'con', /Windows device name/],
  ['Con in mixed case', 'Con', /Windows device name/],
  ['PRN', 'PRN', /Windows device name/],
  ['AUX', 'AUX', /Windows device name/],
  ['NUL', 'NUL', /Windows device name/],
  ['COM1', 'COM1', /Windows device name/],
  ['com9', 'com9', /Windows device name/],
  ['LPT1', 'LPT1', /Windows device name/],
  ['lpt9', 'lpt9', /Windows device name/],
  ['a device name with an extension', 'CON.txt', /Windows device name/],
  ['a device name with a double extension', 'nul.tar.gz', /Windows device name/],
  ['a device name as a directory', 'dir/aux/x', /Windows device name/],
  ['a numbered device name with an extension', 'a/COM1.txt', /Windows device name/],
  ['a device name with a space before the extension', 'CON .txt', /Windows device name/],
  ['COM0', 'COM0', /Windows device name/],
  ['lpt0 with an extension', 'lpt0.log', /Windows device name/],
  ['a superscript-digit device name', 'COM\u00b9', /Windows device name/],
  ['a superscript-three printer', 'LPT\u00b3.log', /Windows device name/],
  ['CONIN$', 'CONIN$', /Windows device name/],
  ['conout$ in a directory', 'a/conout$', /Windows device name/],
];

const ACCEPTED: readonly string[] = [
  'a',
  'a.b',
  'a/b/c.txt',
  'SKILL.md',
  'scripts/run.sh',
  'dir/.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.github/workflows/x.yml',
  '.gitx/config',
  '.git-credentials',
  'git',
  'gitx',
  'git~',
  'git~x',
  'git~1.txt',
  'COM10',
  'LPT10',
  'COM',
  'console.txt',
  'nullable.ts',
  'auxiliary/prn2.txt',
  'concat',
  '.hidden',
  '..hidden',
  'a...b',
  'a b/c d.txt',
  'node_modules/@scope/pkg/index.js',
  '@scope/pkg',
  'a+b',
  'a(1).txt',
  "it's.txt",
  'a,b;c=d',
  '#hash',
  '%20',
  '~tmp',
  '$dollar',
  'caf\u00e9/\u00fc.txt',
  'e\u0301.txt',
  '\u65e5\u672c\u8a9e/\u30d5\u30a1\u30a4\u30eb.md',
  '\u{1f600}.txt',
  'a'.repeat(LIMITS.maxPathBytes),
  '\u00e9'.repeat(LIMITS.maxPathBytes / 2),
  Array.from({ length: LIMITS.maxDepth }, () => 'd').join('/'),
];

const NOT_TEXT: readonly (readonly [what: string, value: unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['a number', 42],
  ['an object', {}],
  ['an array', ['a']],
  ['a boolean', true],
  ['a symbol', Symbol('a')],
  ['a String object', new String('a')],
];

describe('checkEntryPath', () => {
  describe('rejects', () => {
    it.each(REJECTED)('%s', (_what, path, reason) => {
      expect(checkEntryPath(path)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(reason),
      });
    });

    it('a path longer than the limit in bytes', () => {
      expect(checkEntryPath('a'.repeat(LIMITS.maxPathBytes + 1))).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/longer than 240/),
      });
    });

    // The limit is in bytes: 121 two-byte letters are 121 characters and 242 bytes.
    it('a path that is longer than the limit only in UTF-8 bytes', () => {
      const path = '\u00e9'.repeat(LIMITS.maxPathBytes / 2 + 1);

      expect(path.length).toBeLessThan(LIMITS.maxPathBytes);
      expect(checkEntryPath(path)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/longer than 240/),
      });
    });

    it('a path that is deeper than the limit', () => {
      const path = Array.from({ length: LIMITS.maxDepth + 1 }, () => 'd').join('/');

      expect(checkEntryPath(path)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/deeper than 20/),
      });
    });

    it.each(NOT_TEXT)('%s, which is not text', (_what, value) => {
      expect(checkEntryPath(value)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/not text/),
      });
    });

    // The size is judged before the characters are looked at, so that a path of megabytes is
    // refused for its size and never read through.
    it('a path of megabytes', () => {
      for (const path of ['a'.repeat(5_000_000), 'a/'.repeat(2_000_000), '.'.repeat(5_000_000)]) {
        expect(checkEntryPath(path)).toMatchObject({
          ok: false,
          reason: expect.stringMatching(/longer than 240/),
        });
      }
    });

    // The order is part of the promise: a path past the limit is refused for its length, whatever
    // is in it, so nothing is read beyond the first 240 characters of a hostile one.
    it('a path past the limit for its length, even if it also holds a character that is refused', () => {
      for (const bad of ['\ud800', '\u0000', '\u202e', ':', '\\']) {
        const path = 'a'.repeat(LIMITS.maxPathBytes + 1) + bad;

        expect(checkEntryPath(path)).toMatchObject({
          ok: false,
          reason: expect.stringMatching(/longer than 240/),
        });
      }
    });

    // Shapes that a pattern with a nested repeat would be slow on: runs of dots, spaces and
    // half-matched names, at the longest size the check looks at.
    it.each(['.', ' ', 'con', 'git~', '.gi', 'a:', 'a/', 'COM'])(
      'long runs of %j are answered',
      (near) => {
        const path = near.repeat(LIMITS.maxPathBytes).slice(0, LIMITS.maxPathBytes);

        expect(typeof checkEntryPath(path).ok).toBe('boolean');
      },
    );
  });

  describe('accepts', () => {
    it.each(ACCEPTED)('%j', (path) => {
      expect(checkEntryPath(path)).toEqual({ ok: true, path });
    });

    // The digest hashes the bytes of a name as the archive spelled it. Making the name "nicer"
    // would make two different archives the same.
    it('a path exactly as it was given, without normalising it', () => {
      const decomposed = 'cafe\u0301/NAME.TXT';

      expect(checkEntryPath(decomposed)).toEqual({ ok: true, path: decomposed });
    });
  });

  it('gives a reason that is a fixed phrase and never echoes the path', () => {
    const result = checkEntryPath('a\u001b]52;c;ZXZpbA==\u0007\u202e\u200b');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain('52;c');
      expect(result.reason).toBe(neutralizeControls(result.reason));
    }
  });

  // Whatever the check lets through can be shown to a person as it is, with nothing for a terminal
  // or a page to act on. The strings are made mostly of the characters that matter.
  it('lets through nothing that the terminal-safety code would have to rewrite', () => {
    const unit = fc.oneof(
      fc.constantFrom('a', 'b', '/', '.', ' ', '\u00e9', '\u{1f600}'),
      fc.constantFrom(
        '\u0000',
        '\u001b',
        '\u007f',
        '\u0085',
        '\u200b',
        '\u202e',
        '\u2066',
        '\ufe0f',
      ),
      fc.constantFrom('\ufeff', '\u{e0041}', '\u{e0100}', '\ud800', '\ufffd', '\u2028', '\u180e'),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
    );

    fc.assert(
      fc.property(fc.string({ unit, maxLength: 40 }), (path) => {
        if (checkEntryPath(path).ok) {
          expect(neutralizeControls(path)).toBe(path);
          expect(safe(path, 1_000)).toBe(escapeHtml(path));
        }
      }),
      { numRuns: 3_000 },
    );
  });
});
