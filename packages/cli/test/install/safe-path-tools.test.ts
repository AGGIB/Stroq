import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { quotePath, stripTopComponent } from '../../src/install/safe-path.js';
import { escapeHtml, safe } from '../../src/replay/html.js';
import { neutralizeControls } from '../../src/terminal-safe.js';

describe('quotePath', () => {
  it('puts an ordinary path in quotes', () => {
    expect(quotePath('src/a.js')).toBe('"src/a.js"');
  });

  it.each([
    ['an escape sequence', 'a\u001b[2J', '"a\\u001b[2J"'],
    ['a newline', 'a\nb', '"a\\nb"'],
    ['a C1 control', 'a\u009bb', '"a\\u009bb"'],
    ['DEL', 'a\u007fb', '"a\\u007fb"'],
    ['a direction override', 'a\u202eb', '"a\\u202eb"'],
    ['a zero-width space', 'a\u200bb', '"a\\u200bb"'],
    ['a tag character', 'a\u{e0041}b', '"a\\u{e0041}b"'],
    ['a lone surrogate', 'a\ud800b', '"a\\ud800b"'],
    ['a quote and a backslash', 'a"b\\c', '"a\\"b\\\\c"'],
  ])('writes out %s', (_what, path, expected) => {
    expect(quotePath(path)).toBe(expected);
  });

  it('cuts a long path and says so', () => {
    const quoted = quotePath('x'.repeat(500));

    expect(quoted.length).toBeLessThan(100);
    expect(quoted.endsWith('\u2026"')).toBe(true);
  });

  it('leaves nothing for a terminal or a page to act on, whatever it is given', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (path) => {
        const quoted = quotePath(path);

        expect(neutralizeControls(quoted)).toBe(quoted);
        expect(safe(quoted, 10_000)).toBe(escapeHtml(quoted));
        expect(/[\ud800-\udfff]/u.test(quoted)).toBe(false);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('stripTopComponent', () => {
  it('removes the one folder every path sits in', () => {
    expect(stripTopComponent(['pkg/a.txt', 'pkg/b/c.txt'])).toEqual(['a.txt', 'b/c.txt']);
  });

  it('removes exactly one level, even when the next level has the same name', () => {
    expect(stripTopComponent(['a/a/x', 'a/a/y'])).toEqual(['a/x', 'a/y']);
  });

  it('removes the folder of a single file', () => {
    expect(stripTopComponent(['repo-1.0/README.md'])).toEqual(['README.md']);
  });

  it('leaves paths alone when they do not share a folder', () => {
    expect(stripTopComponent(['pkg/a', 'other/b'])).toEqual(['pkg/a', 'other/b']);
  });

  it('leaves paths alone when one of them is not in a folder at all', () => {
    expect(stripTopComponent(['pkg/a', 'README.md'])).toEqual(['pkg/a', 'README.md']);
    expect(stripTopComponent(['README.md'])).toEqual(['README.md']);
  });

  it('is case-sensitive about the folder', () => {
    expect(stripTopComponent(['Pkg/a', 'pkg/b'])).toEqual(['Pkg/a', 'pkg/b']);
  });

  it('leaves an empty list empty', () => {
    expect(stripTopComponent([])).toEqual([]);
  });

  it('does not make an empty path of a path that is only the folder', () => {
    expect(stripTopComponent(['pkg/'])).toEqual(['pkg/']);
    expect(stripTopComponent(['pkg/a', 'pkg/'])).toEqual(['pkg/a', 'pkg/']);
  });

  // Stripping a "folder" that is nothing, or a dot, would turn a path that is refused later into
  // one that is not.
  it.each([
    [['/etc/a', '/etc/b']],
    [['./a', './b']],
    [['../a', '../b']],
    [['\\a', '\\b']],
    [['/a', '/b']],
  ])('does not take the first part of %j for a folder', (paths) => {
    expect(stripTopComponent(paths)).toEqual(paths);
  });

  it('does not change what it is given, and returns a list of its own either way', () => {
    const shared = ['pkg/a', 'pkg/b'];
    const apart = ['x/a', 'y/b'];

    expect(stripTopComponent(shared)).not.toBe(shared);
    expect(stripTopComponent(apart)).not.toBe(apart);
    expect(shared).toEqual(['pkg/a', 'pkg/b']);
    expect(apart).toEqual(['x/a', 'y/b']);
  });

  it('leaves the rest of every path byte for byte as it was', () => {
    expect(stripTopComponent(['top/ caf\u00e9 /a b', 'top/\u{1f600}'])).toEqual([
      ' caf\u00e9 /a b',
      '\u{1f600}',
    ]);
  });
});
