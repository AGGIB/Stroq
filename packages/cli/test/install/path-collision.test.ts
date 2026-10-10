import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  findCollisions,
  findFolderConflicts,
  findFolderSpellings,
  foldCase,
} from '../../src/install/path-collision.js';
import { LIMITS } from '../../src/install/types.js';

const LAST_CODE_POINT = 0x10ffff;
const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

// A disk compares names by a key, and a key is only a key if folding it again changes nothing: if
// `fold(fold(x))` is not `fold(x)`, two names that a disk joins can be given two keys, and the tree
// holds both. Upper-casing and lower-casing in turn is not such a key for one letter: the capital sharp
// s (U+1E9E) becomes the sharp s (U+00DF) the first time and "ss" only the second time.
describe('foldCase', () => {
  const CAPITAL_SHARP_S = '\u1e9e';
  const SHARP_S = '\u00df';

  it('makes the capital sharp s, the sharp s and ss one key, in any case', () => {
    const keys = new Set(
      [CAPITAL_SHARP_S, SHARP_S, 'ss', 'SS', 'Ss', 'sS'].map((text) => foldCase(text)),
    );

    expect([...keys]).toEqual(['ss']);
  });

  it('keeps the letters of a word that holds the capital sharp s joined to the word with ss', () => {
    expect(foldCase(`proce${CAPITAL_SHARP_S}`)).toBe(foldCase('process'));
    expect(foldCase(`STRA${CAPITAL_SHARP_S}E`)).toBe(foldCase('strasse'));
  });

  // Every code point, once. The fold is asked for its own answer again, and for the key of the lower
  // case and of the upper case of the letter: a key that keeps a letter apart from its own lower case
  // joins less than lower-casing does, and a disk that lower-cases would then join what it keeps apart.
  it('is its own fixed point, and joins a letter with its lower and upper case, for every code point', () => {
    const notFixed: string[] = [];
    const apartFromLower: string[] = [];
    const apartFromUpper: string[] = [];
    let changed = 0;

    for (let code = 0; code <= LAST_CODE_POINT; code += 1) {
      const char = String.fromCodePoint(code);
      const key = foldCase(char);
      if (key !== char) changed += 1;
      if (foldCase(key) !== key) notFixed.push(hex(code));
      if (foldCase(char.toLowerCase()) !== key) apartFromLower.push(hex(code));
      if (foldCase(char.toUpperCase()) !== key) apartFromUpper.push(hex(code));
    }

    expect(notFixed).toEqual([]);
    expect(apartFromLower).toEqual([]);
    expect(apartFromUpper).toEqual([]);
    // The fold changes a few thousand code points; a sweep that found none has proved nothing.
    expect(changed).toBeGreaterThan(1_000);
  });

  // The characters that the fold does something unusual to (they change length, change class, or
  // compose with what comes before), in the combinations that could make one pass not enough.
  it('is its own fixed point on strings made of the characters it treats unusually', () => {
    const unusual = fc.constantFrom(
      ...['\u1e9e', '\u00df', 's', 'S', '\u03a3', '\u03c3', '\u03c2', '\u0130', '\u0131', 'i', 'I'],
      ...['\u0149', '\ufb03', '\u01c5', '\u1f88', '\u0301', '\u0307', '\u0345', 'e', 'E', '.', '/'],
    );
    const text = fc.array(unusual, { maxLength: 8 }).map((parts) => parts.join(''));

    fc.assert(
      fc.property(text, (name) => {
        expect(foldCase(foldCase(name))).toBe(foldCase(name));
      }),
      { numRuns: 3_000 },
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

  // U+1E9E is the capital of the sharp s, and a disk that folds case joins it with both the sharp s
  // and (as full case folding does) with ss. All three pairs are collisions, whichever way round.
  it('pairs the capital sharp s with the sharp s and with ss', () => {
    expect(findCollisions(['\u1e9e.md', '\u00df.md'])).toHaveLength(1);
    expect(findCollisions(['\u00df.md', '\u1e9e.md'])).toHaveLength(1);
    expect(findCollisions(['\u1e9e.md', 'ss.md'])).toHaveLength(1);
    expect(findCollisions(['\u00df.md', 'ss.md'])).toHaveLength(1);
    expect(findCollisions(['proce\u1e9e.md', 'process.md'])).toHaveLength(1);
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

// Two folders that are one folder on a disk that ignores letter case and Unicode form, spelled two
// ways: the disk makes the folder once, with the first spelling it is given, and writes the files of
// both into it. A read of the disk then lists a path that was never inspected.
describe('findFolderSpellings', () => {
  it('pairs two paths whose folders differ only in case', () => {
    expect(findFolderSpellings(['Docs/a.md', 'docs/b.md'])).toEqual([['Docs/a.md', 'docs/b.md']]);
  });

  it('pairs a composed and a decomposed letter in a folder name', () => {
    expect(findFolderSpellings(['café/a', 'café/b'])).toEqual([['café/a', 'café/b']]);
  });

  it('pairs names that a filesystem with fuller case rules would also join', () => {
    expect(findFolderSpellings(['straße/a', 'STRASSE/b'])).toHaveLength(1);
    expect(findFolderSpellings(['ẞ/a', 'ss/b'])).toHaveLength(1);
  });

  it('finds it at any depth', () => {
    expect(findFolderSpellings(['x/Docs/a', 'x/docs/b'])).toHaveLength(1);
    expect(findFolderSpellings(['A/b/x', 'a/b/y'])).toHaveLength(1);
    expect(findFolderSpellings(['a/B/x', 'a/b/y'])).toHaveLength(1);
  });

  it('pairs each later path with the first one through the folder, once each, in input order', () => {
    expect(findFolderSpellings(['Docs/a', 'docs/b', 'Docs/c', 'DOCS/d'])).toEqual([
      ['Docs/a', 'docs/b'],
      ['Docs/a', 'DOCS/d'],
    ]);
  });

  it('pairs a path once, for the folder nearest the root that it spells differently', () => {
    expect(findFolderSpellings(['A/B/x', 'a/b/y'])).toEqual([['A/B/x', 'a/b/y']]);
  });

  it('says nothing of paths whose folders are spelled alike', () => {
    expect(findFolderSpellings(['Docs/a', 'Docs/b', 'Docs/sub/c', 'other/Docs/d'])).toEqual([]);
    expect(findFolderSpellings(['a/b/c', 'a/b/d', 'a/e'])).toEqual([]);
  });

  it('says nothing of the same folder name under two different folders', () => {
    expect(findFolderSpellings(['a/Docs/x', 'b/docs/y'])).toEqual([]);
  });

  // The names of the files themselves are for findCollisions, and a file against a folder of the
  // same name is for findFolderConflicts.
  it('says nothing of the last component of a path', () => {
    expect(findFolderSpellings(['Docs/a.md', 'Docs/A.md'])).toEqual([]);
    expect(findFolderSpellings(['Docs', 'docs/x'])).toEqual([]);
    expect(findFolderSpellings(['a', 'A'])).toEqual([]);
  });

  it('says nothing of nothing', () => {
    expect(findFolderSpellings([])).toEqual([]);
    expect(findFolderSpellings(['only'])).toEqual([]);
    expect(findFolderSpellings(['only/one'])).toEqual([]);
  });

  it('does not change what it is given', () => {
    const paths = ['b/Docs/c', 'b/docs/d', 'a'];
    findFolderSpellings(paths);

    expect(paths).toEqual(['b/Docs/c', 'b/docs/d', 'a']);
  });

  it('keeps the answer no longer than the input when every path spells the folder its own way', () => {
    const letters = Array.from('abcdefghijkl');
    const spellings = Array.from({ length: 1 << letters.length }, (_, bits) =>
      letters.map((letter, at) => (bits & (1 << at) ? letter.toUpperCase() : letter)).join(''),
    ).slice(0, LIMITS.maxEntries);
    const pairs = findFolderSpellings(spellings.map((spelling) => `${spelling}/file`));

    expect(pairs).toHaveLength(spellings.length - 1);
    expect(pairs.every(([first]) => first === `${spellings[0]}/file`)).toBe(true);
  });

  // A name longer than a path may be is not folded (see FOLDED_UNITS), so its spellings are two names.
  it('leaves a name longer than a path may be as it is', () => {
    const tooLong = 'A'.repeat(LIMITS.maxPathBytes + 1);

    expect(findFolderSpellings([`${tooLong}/a`, `${tooLong.toLowerCase()}/b`])).toEqual([]);
    expect(findFolderSpellings([`${tooLong}/a`, `${tooLong}/b`])).toEqual([]);
  });
});
