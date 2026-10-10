import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findCollisions, findFolderConflicts } from '../../src/install/path-collision.js';
import { quotePath, stripTopComponent } from '../../src/install/safe-path.js';
import { LIMITS } from '../../src/install/types.js';
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

describe('findCollisions', () => {
  it('pairs two paths that differ only in case', () => {
    expect(findCollisions(['a/README', 'a/readme'])).toEqual([['a/README', 'a/readme']]);
  });

  it('pairs a composed and a decomposed letter', () => {
    expect(findCollisions(['caf\u00e9.txt', 'cafe\u0301.txt'])).toEqual([
      ['caf\u00e9.txt', 'cafe\u0301.txt'],
    ]);
  });

  it('pairs paths that differ in both case and composition', () => {
    expect(findCollisions(['\u00c9.txt', 'e\u0301.txt'])).toEqual([['\u00c9.txt', 'e\u0301.txt']]);
  });

  it('finds a collision in a directory name, not only in the file name', () => {
    expect(findCollisions(['Docs/x.md', 'docs/x.md'])).toEqual([['Docs/x.md', 'docs/x.md']]);
  });

  // Some filesystems fold more than ASCII does: sharp s with ss, and the two sigmas. A tree that
  // would lose a file on one of them is refused everywhere.
  it('pairs paths that a filesystem with fuller case rules would also join', () => {
    expect(findCollisions(['stra\u00dfe.md', 'STRASSE.md'])).toHaveLength(1);
    expect(findCollisions(['\u03b1\u03c3', '\u03b1\u03c2'])).toHaveLength(1);
  });

  it('says nothing of paths that are different', () => {
    expect(findCollisions(['a/b', 'a/c', 'ab', 'A.txt/b', 'b/a'])).toEqual([]);
    expect(findCollisions([])).toEqual([]);
    expect(findCollisions(['only'])).toEqual([]);
  });

  it('does not take a file and a folder of one name for a collision', () => {
    expect(findCollisions(['a', 'a/b'])).toEqual([]);
  });

  it('pairs each later path of a group with the first one of it, in input order', () => {
    expect(findCollisions(['x/a', 'q', 'x/A', 'X/a', 'x/B'])).toEqual([
      ['x/a', 'x/A'],
      ['x/a', 'X/a'],
    ]);
  });

  // Two entries of one name overwrite one another as surely as two that differ in case.
  it('reports a path that appears twice', () => {
    expect(findCollisions(['a', 'a'])).toEqual([['a', 'a']]);
  });

  it('keeps the output linear in the input when every path collides', () => {
    const paths = Array.from({ length: LIMITS.maxEntries }, (_, i) =>
      i % 2 === 0 ? 'Dir/FILE' : 'dir/file',
    );
    const pairs = findCollisions(paths);

    expect(pairs).toHaveLength(LIMITS.maxEntries - 1);
    expect(pairs.every(([first]) => first === 'Dir/FILE')).toBe(true);
  });

  it('does not change what it is given', () => {
    const paths = ['b', 'B', 'a'];
    findCollisions(paths);

    expect(paths).toEqual(['b', 'B', 'a']);
  });

  // Folders are not entries: two that differ only in case are one folder on a disk that ignores case,
  // and the files in them collide only if their whole paths do.
  it('compares whole paths: two folders that differ in case are not a collision of files', () => {
    expect(findCollisions(['Docs/a.md', 'docs/b.md'])).toEqual([]);
    expect(findCollisions(['Docs/a.md', 'docs/A.md'])).toEqual([['Docs/a.md', 'docs/A.md']]);
  });

  // Normalising is quadratic on a long run of combining marks of mixed classes, so a name that no
  // entry could have is not normalised at all. It is refused by checkEntryPath before it could be one.
  describe('on a name longer than a path may be', () => {
    const tooLong = 'A'.repeat(LIMITS.maxPathBytes + 1);

    it('keeps it as it is: the spellings of it are different names', () => {
      expect(findCollisions([tooLong, tooLong.toLowerCase()])).toEqual([]);
    });

    it('still pairs two that are the same', () => {
      expect(findCollisions([tooLong, tooLong])).toEqual([[tooLong, tooLong]]);
    });

    it('folds a name of exactly the limit', () => {
      const atLimit = 'A'.repeat(LIMITS.maxPathBytes);

      expect(findCollisions([atLimit, atLimit.toLowerCase()])).toHaveLength(1);
    });

    it('folds the other names of the path all the same', () => {
      expect(findCollisions([`${tooLong}/README`, `${tooLong}/readme`])).toHaveLength(1);
    });
  });
});

describe('findFolderConflicts', () => {
  it('pairs a file with a folder whose name differs only in case', () => {
    expect(findFolderConflicts(['Docs', 'docs/x'])).toEqual([['Docs', 'docs/x']]);
  });

  it('pairs a file with a folder of the same spelling, too', () => {
    expect(findFolderConflicts(['a', 'a/b'])).toEqual([['a', 'a/b']]);
  });

  it('finds it at any depth', () => {
    expect(findFolderConflicts(['a/B', 'A/b/c'])).toEqual([['a/B', 'A/b/c']]);
  });

  it('pairs a composed and a decomposed letter', () => {
    expect(findFolderConflicts(['caf\u00e9', 'cafe\u0301/x'])).toEqual([
      ['caf\u00e9', 'cafe\u0301/x'],
    ]);
  });

  it('pairs a path once for each of its folders that matches, nearest the root first', () => {
    expect(findFolderConflicts(['A', 'a/B', 'a/b/c'])).toEqual([
      ['A', 'a/B'],
      ['A', 'a/b/c'],
      ['a/B', 'a/b/c'],
    ]);
  });

  it('names the first of the paths that share a name as the file', () => {
    expect(findFolderConflicts(['x', 'X', 'x/y'])).toEqual([['x', 'x/y']]);
  });

  it('says nothing of names that merely begin alike', () => {
    expect(findFolderConflicts(['a', 'ab/c', 'a.b/c', 'x/a/b', 'a-b', 'b/a'])).toEqual([]);
  });

  it('never pairs a path with itself, or a path given twice (that is a collision)', () => {
    expect(findFolderConflicts(['a/b'])).toEqual([]);
    expect(findFolderConflicts(['a', 'a'])).toEqual([]);
    expect(findCollisions(['a', 'a'])).toHaveLength(1);
  });

  it('says nothing of nothing', () => {
    expect(findFolderConflicts([])).toEqual([]);
    expect(findFolderConflicts(['only'])).toEqual([]);
  });

  it('does not change what it is given', () => {
    const paths = ['b/c', 'B', 'a'];
    findFolderConflicts(paths);

    expect(paths).toEqual(['b/c', 'B', 'a']);
  });

  it('keeps the answer as long as the work when every path is below one file', () => {
    const paths = ['A', ...Array.from({ length: LIMITS.maxEntries }, (_, i) => `a/${i}`)];

    expect(findFolderConflicts(paths)).toHaveLength(LIMITS.maxEntries);
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
