import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildTree, TreeError, treeDigest, treeManifest } from '../../src/install/tree.js';
import { LIMITS, type TreeEntry } from '../../src/install/types.js';
import { codeOf, fileEntry, gitlinkEntry, refusal, symlinkEntry } from '../helpers/install-tree.js';

// A Linux tarball can hold README and readme, and no case-insensitive disk (NTFS, the default APFS,
// HFS+) can: one of them would overwrite the other, and the bytes that were looked at would not be the
// bytes on the disk. So a tree that cannot be written to every disk is not a tree. The refusal is part
// of the contract of the tree and not of any one reader, so every way of making a digest meets it: it
// is found when the digest is taken, not when the files are written.

// The two phrases, whole: they are what a person is told, and they name no path.
const COLLISION =
  'two entries have names that are one name on a filesystem that ignores letter case or Unicode form, so this tree cannot be written to every disk';
const FOLDER_COLLISION =
  'an entry and the folder of another entry have names that are one name on a filesystem that ignores letter case or Unicode form, so this tree cannot be written to every disk';

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
        // The later of the two in byte order, whichever order they were given in.
        expect(error.path).toBe(byteOrderLater(one, other));
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
        // The entry that is below the other is named, as it is for a file and folder of one spelling.
        expect(error.path).toBe(paths[1]);
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

describe('what is refused first', () => {
  it('a path that is the same twice is a duplicate, not a collision', () => {
    expect(codeOf(files('a', 'a'))).toBe('duplicate-path');
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
    ['two folders that differ in case, holding different files', ['Docs/a.md', 'docs/b.md']],
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
    const a = treeDigest({ entries: files('Docs/a.md', 'docs/b.md', 'README') });
    const b = treeDigest({ entries: files('README', 'docs/b.md', 'Docs/a.md') });

    expect(a).toBe(b);
  });
});

// The rule, written once more in the simplest way that is right for letters of the ASCII alphabet,
// and set against the tree on every small set of names it can make.
describe('the rule, against a plain reading of it', () => {
  const part = fc.constantFrom('a', 'A', 'b', 'B');
  const path = fc.array(part, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
  const paths = fc.uniqueArray(path, { minLength: 1, maxLength: 7 });

  /** Whether a plain reading says the set cannot be written to a disk that ignores case. */
  function cannotBeWritten(list: readonly string[]): boolean {
    const names = list.map((p) => p.toLowerCase());
    const taken = new Set(names);
    if (taken.size !== names.length) return true;
    return names.some((name) => {
      const parts = name.split('/');
      return parts.slice(0, -1).some((_, i) => taken.has(parts.slice(0, i + 1).join('/')));
    });
  }

  it('refuses a set of names if and only if it cannot be written', () => {
    fc.assert(
      fc.property(paths, (list) => {
        let refused = false;
        try {
          buildTree(files(...list));
        } catch (error) {
          if (!(error instanceof TreeError)) throw error;
          refused = true;
          expect(['path-conflict', 'path-collision']).toContain(error.code);
        }
        expect(refused, JSON.stringify(list)).toBe(cannotBeWritten(list));
      }),
      { numRuns: 1_500 },
    );
  });
});
