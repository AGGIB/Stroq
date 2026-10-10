import { describe, expect, it } from 'vitest';
import { findCollisions, findFolderConflicts } from '../../src/install/path-collision.js';
import { LIMITS } from '../../src/install/types.js';

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
