import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildTree, TreeError, treeDigest, treeManifest } from '../../src/install/tree.js';
import { LIMITS, type TreeEntry } from '../../src/install/types.js';
import { codeOf, fileEntry, gitlinkEntry, refusal, symlinkEntry } from '../helpers/install-tree.js';

// A Linux tarball can hold README and readme, and no case-insensitive disk (NTFS, the default APFS,
// HFS+) can: one of them would overwrite the other, and the bytes that were looked at would not be the
// bytes on the disk. It can hold Docs/a.md and docs/b.md too, and such a disk merges the two folders and
// keeps the spelling of the first, so a read of the disk lists a path that was never looked at. A tree
// that cannot be written to a disk like that and read back as the same list of paths is not a tree. The
// refusal is part of the contract of the tree and not of any one reader, so every way of making a digest
// meets it: it is found when the digest is taken, not when the files are written.

// The three phrases, whole: they are what a person is told, and they name no path.
const COLLISION =
  'two entries have names that are one name on a filesystem that ignores letter case or Unicode form, so this tree cannot be written to every disk';
const FOLDER_COLLISION =
  'an entry and the folder of another entry have names that are one name on a filesystem that ignores letter case or Unicode form, so this tree cannot be written to every disk';
const FOLDER_SPELLING =
  'two entries are in folders whose names are one name on a filesystem that ignores letter case or Unicode form, but are spelled differently, so this tree cannot be written to every disk';

const files = (...paths: string[]): TreeEntry[] => paths.map((path) => fileEntry(path, 'x'));

/** The refusal each way of using a tree meets, which must be the same in all three. */
function refusals(entries: readonly TreeEntry[]): readonly TreeError[] {
  return [
    refusal(() => buildTree(entries)),
    refusal(() => treeDigest({ entries })),
    refusal(() => treeManifest({ entries })),
  ];
}

const byteOrderLater = (a: string, b: string): string =>
  Buffer.compare(Buffer.from(a), Buffer.from(b)) > 0 ? a : b;
const byteOrderEarlier = (a: string, b: string): string => (byteOrderLater(a, b) === a ? b : a);

describe('two names that are one name on some disks', () => {
  it.each([
    ['letter case', 'README', 'readme'],
    ['letter case in a folder name', 'Docs/x.md', 'docs/x.md'],
    ['letter case at any depth', 'a/B/c', 'a/b/C'],
    ['Unicode composition', 'caf\u00e9.txt', 'cafe\u0301.txt'],
    ['letter case and composition', '\u00c9.txt', 'e\u0301.txt'],
    ['a sharp s and ss', 'stra\u00dfe.md', 'STRASSE.md'],
    ['a capital sharp s and a sharp s', '\u1e9e.md', '\u00df.md'],
    ['a capital sharp s and ss', '\u1e9e.md', 'ss.md'],
    ['a capital sharp s in a word and ss', 'proce\u1e9e.md', 'process.md'],
    ['the two sigmas', '\u03b1\u03c3', '\u03b1\u03c2'],
    ['a dotless i and i', 'i.md', '\u0131.md'],
  ])('%s', (_what, one, other) => {
    for (const entries of [files(one, other), files(other, one)]) {
      for (const error of refusals(entries)) {
        expect(error).toBeInstanceOf(TreeError);
        expect(error.code).toBe('path-collision');
        expect(error.message).toBe(COLLISION);
        // The later of the two in byte order, whichever order they were given in, and the other one.
        expect(error.path).toBe(byteOrderLater(one, other));
        expect(error.other).toBe(byteOrderEarlier(one, other));
      }
    }
  });

  // The paths are text from outside. The message is a fixed phrase, the same for every pair, so that
  // it can be printed whatever the names were; the names are in `path` for whoever shows them with care.
  it('is said in a fixed phrase that never repeats a name', () => {
    const [first] = refusals(files('SECRET-NAME', 'secret-name'));
    const [second] = refusals(files('caf\u00e9', 'cafe\u0301'));

    expect(first?.message).toBe(second?.message);
    expect(first?.message).not.toMatch(/secret|SECRET/);
    expect(second?.message).not.toContain('caf');
  });

  it('is found among thousands of other entries', () => {
    const many = Array.from({ length: LIMITS.maxEntries - 2 }, (_, i) => `dir/file-${i}.txt`);
    const error = refusal(() => buildTree(files(...many, 'Same', 'same')));

    expect(error.code).toBe('path-collision');
    expect(error.path).toBe('same');
  });

  // 4,096 spellings of one name, all different, every one a collision with every other.
  it('is found when every one of the entries is a spelling of one name', () => {
    const letters = Array.from('abcdefghijkl');
    const spellings = Array.from({ length: 1 << letters.length }, (_, bits) =>
      letters.map((letter, at) => (bits & (1 << at) ? letter.toUpperCase() : letter)).join(''),
    );

    expect(spellings).toHaveLength(4_096);
    expect(codeOf(files(...spellings))).toBe('path-collision');
  });

  it('is told apart from a path that is given twice, which is a duplicate', () => {
    expect(codeOf(files('Dir/FILE', 'Dir/FILE'))).toBe('duplicate-path');
  });

  it('whatever kind of entry the two are', () => {
    expect(codeOf([symlinkEntry('Link', 't'), fileEntry('link', 'x')])).toBe('path-collision');
    expect(codeOf([gitlinkEntry('Sub'), gitlinkEntry('sub')])).toBe('path-collision');
    expect(codeOf([fileEntry('A', 'x'), symlinkEntry('a', 't')])).toBe('path-collision');
  });
});

describe('a file and a folder that are one name on some disks', () => {
  it.each([
    ['letter case', ['Docs', 'docs/x']],
    ['letter case, the folder first', ['docs', 'Docs/x']],
    ['letter case at any depth', ['a/B', 'A/b/c']],
    ['Unicode composition', ['caf\u00e9', 'cafe\u0301/x']],
    ['a folder of a folder', ['x/Y', 'x/y/z/w']],
  ])('%s', (_what, paths) => {
    for (const entries of [files(...paths), files(...[...paths].reverse())]) {
      for (const error of refusals(entries)) {
        expect(error.code).toBe('path-collision');
        expect(error.message).toBe(FOLDER_COLLISION);
        // The entry that is below the other is named, as it is for a file and folder of one spelling,
        // and `other` is the file it is below.
        expect(error.path).toBe(paths[1]);
        expect(error.other).toBe(paths[0]);
      }
    }
  });

  it('whatever kind of entry the file is', () => {
    expect(codeOf([symlinkEntry('Link', 't'), fileEntry('link/x', 'x')])).toBe('path-collision');
    expect(codeOf([gitlinkEntry('Vendor'), fileEntry('vendor/x', 'x')])).toBe('path-collision');
  });

  it('with a message that repeats no name either', () => {
    const [error] = refusals(files('SECRET', 'secret/x'));

    expect(error?.message).not.toMatch(/secret|SECRET/);
  });
});

describe('two folders that are one folder on some disks', () => {
  it.each([
    ['letter case', 'Docs/a.md', 'docs/b.md'],
    ['letter case, in a folder of a folder', 'x/Docs/a.md', 'x/docs/b.md'],
    ['letter case in the first of two folders', 'A/b/x', 'a/b/y'],
    ['letter case in the last of two folders', 'a/B/x', 'a/b/y'],
    ['Unicode composition', 'caf\u00e9/a.md', 'cafe\u0301/b.md'],
    ['letter case and composition', '\u00c9/a', 'e\u0301/b'],
    ['a sharp s and ss', 'stra\u00dfe/a', 'STRASSE/b'],
    ['a capital sharp s and ss', '\u1e9e/a', 'ss/b'],
    ['a dotless i and i', 'i/a', '\u0131/b'],
  ])('%s', (_what, one, other) => {
    for (const entries of [files(one, other), files(other, one)]) {
      for (const error of refusals(entries)) {
        expect(error).toBeInstanceOf(TreeError);
        expect(error.code).toBe('path-collision');
        expect(error.message).toBe(FOLDER_SPELLING);
        // The later of the two in byte order, whichever order they were given in, and the other one.
        expect(error.path).toBe(byteOrderLater(one, other));
        expect(error.other).toBe(byteOrderEarlier(one, other));
      }
    }
  });

  it('whatever kind of entry the two are', () => {
    expect(codeOf([symlinkEntry('Docs/l', 't'), fileEntry('docs/f', 'x')])).toBe('path-collision');
    expect(codeOf([gitlinkEntry('Vendor/sub'), fileEntry('vendor/x', 'x')])).toBe('path-collision');
    expect(codeOf([gitlinkEntry('A/s'), symlinkEntry('a/t', 'x')])).toBe('path-collision');
  });

  it('with a message that repeats no name', () => {
    const [error] = refusals(files('SECRET/a', 'secret/b'));

    expect(error?.message).not.toMatch(/secret|SECRET/);
  });

  // The same folder name under two different folders is two folders, and so is one spelling used twice.
  it('does not refuse folders that are not one folder, or one folder spelled one way', () => {
    for (const paths of [
      ['a/Docs/x', 'b/docs/y'],
      ['Docs/a', 'Docs/b', 'Docs/sub/c', 'other/docs/d'],
      ['Docs/a.md', 'Docs/b.md', 'docs-x/c.md'],
    ]) {
      expect(() => buildTree(files(...paths)), paths.join(' ')).not.toThrow();
    }
  });

  it('is said after a name that is one name, and after a file in the way of a folder', () => {
    expect(refusal(() => buildTree(files('Docs/a', 'docs/a', 'DOCS/b'))).message).toBe(COLLISION);
    expect(refusal(() => buildTree(files('Docs', 'docs/x', 'DOCS/y'))).message).toBe(
      FOLDER_COLLISION,
    );
  });
});

describe('what is refused first', () => {
  it('a path that is the same twice is a duplicate, not a collision', () => {
    expect(codeOf(files('a', 'a'))).toBe('duplicate-path');
  });

  it('has no other path to name unless it is a collision', () => {
    expect(refusal(() => buildTree(files('a', 'a'))).other).toBeNull();
    expect(refusal(() => buildTree(files('a', 'a/b'))).other).toBeNull();
    expect(refusal(() => buildTree(files('../x'))).other).toBeNull();
    expect(refusal(() => buildTree([{ ...fileEntry('c', 'x'), size: 9 }])).other).toBeNull();
  });

  it('a file and a folder of one spelling are a conflict, with the path in the message', () => {
    const error = refusal(() => buildTree(files('a', 'a/b')));

    expect(error.code).toBe('path-conflict');
    expect(error.message).toContain('"a/b"');
  });

  it('a path that is not safe to write comes before any collision', () => {
    expect(codeOf([...files('README', 'readme'), fileEntry('../x', 'x')])).toBe('bad-path');
  });

  it('an entry that is not an entry comes before any collision', () => {
    const broken = { ...fileEntry('c', 'x'), size: 9 };

    expect(codeOf([...files('README', 'readme'), broken])).toBe('size-mismatch');
  });
});

describe('names that are not one name', () => {
  it.each([
    ['names that begin alike', ['readme', 'readme.md', 'README.txt']],
    ['a folder and files whose names begin like it', ['lib-x', 'lib.js', 'lib/a.js']],
    ['a folder named like a file with an extension', ['a.b', 'a/b']],
    ['a letter and its accented form', ['e.txt', '\u00e9.txt']],
    ['different letters', ['i.md', 'j.md']],
    // No filesystem treats a full-width z as a z; the compatibility step is for fixed names only.
    ['a full-width letter and the plain one', ['z.txt', '\uff5a.txt']],
  ])('%s', (_what, paths) => {
    const entries = files(...paths);

    expect(() => buildTree(entries)).not.toThrow();
    expect(treeDigest({ entries })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a tree with the same names in a different order has the same digest', () => {
    const a = treeDigest({ entries: files('Docs/a.md', 'Docs/b.md', 'README') });
    const b = treeDigest({ entries: files('README', 'Docs/b.md', 'Docs/a.md') });

    expect(a).toBe(b);
  });
});

// The promise, set against a model of a disk. The model ignores letter case (and, for the second
// alphabet, Unicode form) and keeps the spelling that a folder or a file was first made with, as NTFS and
// the default APFS do. A tree is written to it in some order and the disk is read back: the tree can be
// written when what is read back is exactly the list of paths that was written. That is what makes the
// digest of what was inspected the digest of what is on the disk. The rule that refuses a tree has to
// say the same as the model, both ways round and in either order of writing, on every small set of
// names the alphabet can make. The model's own way of comparing names is not the module's: it is the
// plainest one that is right for its alphabet.
describe('the rule, against a model of a disk', () => {
  type Made =
    | { readonly kind: 'file'; readonly spelled: string }
    | { readonly kind: 'folder'; readonly spelled: string; readonly below: Map<string, Made> };

  type KeyOf = (name: string) => string;
  const byCase: KeyOf = (name) => name.toLowerCase();
  const byCaseAndForm: KeyOf = (name) => name.normalize('NFC').toUpperCase().toLowerCase();

  /**
   * Writes `list` in order to the model and returns the paths a read of the disk lists, sorted; or null
   * when a write fails because a file is where a folder is wanted, or a folder where a file is wanted.
   */
  function readBack(list: readonly string[], keyOf: KeyOf): string[] | null {
    const root = new Map<string, Made>();
    for (const path of list) {
      const names = path.split('/');
      let level = root;
      for (const [at, name] of names.entries()) {
        const key = keyOf(name);
        const found = level.get(key);
        if (at === names.length - 1) {
          if (found?.kind === 'folder') return null;
          // A file written over a file keeps the name the first one was made with.
          level.set(key, { kind: 'file', spelled: found?.spelled ?? name });
        } else {
          if (found?.kind === 'file') return null;
          const folder = found ?? { kind: 'folder', spelled: name, below: new Map() };
          level.set(key, folder);
          level = folder.below;
        }
      }
    }
    return listing(root, '').sort();
  }

  function listing(level: ReadonlyMap<string, Made>, prefix: string): string[] {
    return [...level.values()].flatMap((made) =>
      made.kind === 'file'
        ? [`${prefix}${made.spelled}`]
        : listing(made.below, `${prefix}${made.spelled}/`),
    );
  }

  const canBeWritten = (list: readonly string[], keyOf: KeyOf): boolean =>
    readBack(list, keyOf)?.join('\n') === [...list].sort().join('\n');

  it('is a model that notices each of the faults', () => {
    expect(canBeWritten(['a/b', 'b/a'], byCase)).toBe(true);
    // A file over a file of another spelling: one of the two is lost.
    expect(canBeWritten(['A', 'a'], byCase)).toBe(false);
    // A file where a folder is wanted, and the other way round.
    expect(canBeWritten(['a', 'a/b'], byCase)).toBe(false);
    expect(canBeWritten(['a/b', 'a'], byCase)).toBe(false);
    // One folder spelled two ways: the second path is read back as another path than was written.
    expect(canBeWritten(['Docs/a', 'docs/b'], byCase)).toBe(false);
    expect(canBeWritten(['docs/b', 'Docs/a'], byCase)).toBe(false);
    // And with a composed and a decomposed letter, which only the second way of comparing joins.
    expect(canBeWritten(['caf\u00e9/a', 'cafe\u0301/b'], byCase)).toBe(true);
    expect(canBeWritten(['caf\u00e9/a', 'cafe\u0301/b'], byCaseAndForm)).toBe(false);
  });

  const ALPHABETS: readonly (readonly [what: string, names: readonly string[], keyOf: KeyOf])[] = [
    ['letter case', ['a', 'A', 'b', 'B'], byCase],
    [
      'letter case and Unicode form',
      ['e', 'E', 'caf\u00e9', 'cafe\u0301', 'CAF\u00c9', 'ss', '\u00df', 'SS'],
      byCaseAndForm,
    ],
  ];

  it.each(ALPHABETS)(
    'refuses a set of names if and only if the model cannot write it back, in any order: %s',
    (_what, names, keyOf) => {
      const part = fc.constantFrom(...names);
      const path = fc.array(part, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
      const paths = fc.uniqueArray(path, { minLength: 1, maxLength: 7 });
      let written = 0;
      let refused = 0;

      fc.assert(
        fc.property(paths, (list) => {
          let isRefused = false;
          try {
            buildTree(files(...list));
          } catch (error) {
            if (!(error instanceof TreeError)) throw error;
            isRefused = true;
            expect(['path-conflict', 'path-collision']).toContain(error.code);
          }
          for (const order of [list, [...list].reverse()]) {
            expect(isRefused, JSON.stringify(order)).toBe(!canBeWritten(order, keyOf));
          }
          if (isRefused) refused += 1;
          else written += 1;
        }),
        { numRuns: 1_500 },
      );

      // Not a count to keep up with: only that both kinds of set were met, many times.
      expect(written).toBeGreaterThan(100);
      expect(refused).toBeGreaterThan(100);
    },
  );
});
