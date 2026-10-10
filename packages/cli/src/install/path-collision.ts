// When two spellings are one name.
//
// A filesystem that ignores letter case and Unicode form (NTFS, the default APFS, HFS+) takes `README`
// and `readme` for one name, and a composed and a decomposed "e acute" for one name. A tree written to
// such a disk would lose a file, or would read back as another list of paths than the one that was
// inspected. This file holds the folding that decides when two spellings are one name, and the rules
// built on it, which `tree.ts` applies to every tree. It is plain ASCII on purpose, as `safe-path.ts`
// is. The folding follows the Unicode tables of the Node that runs it.
import { LIMITS } from './types.js';

// ---------------------------------------------------------------------------------------------
// Folding: when two spellings are one name
// ---------------------------------------------------------------------------------------------

/**
 * A name longer than this is not the name of an entry (`checkEntryPath` refuses it), and is not
 * folded. Normalisation is quadratic on a long run of combining marks of mixed classes (65,536 of
 * them take three seconds), so a hostile name of any length would otherwise hold the process for as
 * long as it likes. A longer name is kept as it is, which is the same as saying its spellings are
 * different names.
 */
const FOLDED_UNITS = LIMITS.maxPathBytes;

/** One round of the fold: NFC, upper case, lower case, NFC. */
const foldOnce = (text: string): string =>
  text.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');

/**
 * The most rounds of the fold a name is given. A name needs two at most: the capital sharp s (U+1E9E)
 * becomes the sharp s (U+00DF) in the first and "ss" in the second, and every other code point settles
 * in one (`path-collision.test.ts` asks about all of them). The third round is the one that shows the
 * second changed nothing.
 */
const FOLD_ROUNDS = 3;

/**
 * A name as a filesystem that ignores letter case and Unicode form would see it (NTFS, the default
 * APFS, HFS+). Composed and decomposed letters are one (NFC). Case is folded through upper case and
 * back, which joins more than lower-casing alone does (the sharp s with "ss", the two sigmas, the
 * dotless i with "i"): a tree that would lose a file on a filesystem that folds that far is refused
 * on all of them.
 *
 * The fold is repeated until a round changes nothing. A key that can be folded again is not a key: the
 * capital sharp s folds to the sharp s in one round and to "ss" in two, so with one round it would be
 * kept apart from both the sharp s and "ss", which a disk that folds case joins with it, and a tree
 * that holds the two would lose a file there.
 */
export function foldCase(text: string): string {
  let folded = text;
  for (let round = 0; round < FOLD_ROUNDS; round += 1) {
    const next = foldOnce(folded);
    if (next === folded) break;
    folded = next;
  }
  return folded;
}

/** One component as the collision rule sees it. */
const collisionName = (name: string): string =>
  name.length > FOLDED_UNITS ? name : foldCase(name);

/**
 * One component as it is matched against a fixed name (`.git`, `git~1`, a device). It is folded as
 * `collisionName` folds, after one more step in front: the compatibility forms are made plain (NFKC),
 * so that full-width letters and dots, superscript digits and the circled and mathematical letters
 * are the ordinary ones. A program that converts a name to a narrower character set does the same,
 * and `CON` written wide opens the console. Because it is the same folding with that step added, a
 * name cannot pass the rules for fixed names and be taken for the same name by the collision rule, or
 * the other way round (the dotless i is `i` to both).
 *
 * The collision rule itself stops at NFC: no filesystem treats a full-width `z` and `z` as one name,
 * and CJK names use the full-width forms on purpose.
 */
export const nameKey = (name: string): string =>
  name.length > FOLDED_UNITS ? name : foldCase(name.normalize('NFKC'));

// ---------------------------------------------------------------------------------------------
// Names that are one name on some disks
// ---------------------------------------------------------------------------------------------

/**
 * The components of a path as a filesystem that ignores letter case and Unicode form compares them,
 * one name at a time (see `foldCase`). A path is the same as another when all of these are. Folding
 * one name at a time and not the whole path changes nothing, since no folding step reaches across a
 * `/`, but it gives the folders of a path for free.
 */
const foldedParts = (path: string): string[] => path.split('/').map(collisionName);

/**
 * The pairs of paths that cannot both be written to a filesystem that ignores letter case and Unicode
 * form: `a/README` and `a/readme`, or a composed and a decomposed "e acute". Each path after the first
 * of a group is paired with that first one, so the answer is as long as the input at most however
 * many collide. A path given twice is a collision with itself: the second overwrites the first.
 *
 * It compares whole paths. Two folders that differ only in case are one folder there, and the files in
 * them collide only when their whole paths do. A file and a folder of one name (`a` and `a/b`, or
 * `Docs` and `docs/x`) is a different fault, found by `findFolderConflicts`. A name longer than a path
 * may be is not folded (see `FOLDED_UNITS`), so two spellings of it are two names here: it is refused
 * by `checkEntryPath` before it could be an entry.
 */
export function findCollisions(paths: readonly string[]): readonly (readonly [string, string])[] {
  const firstOfKey = new Map<string, string>();
  const pairs: (readonly [string, string])[] = [];
  for (const path of paths) {
    const key = foldedParts(path).join('/');
    const first = firstOfKey.get(key);
    if (first === undefined) firstOfKey.set(key, path);
    else pairs.push([first, path]);
  }
  return pairs;
}

/**
 * The pairs `[file, below]` where a folder of `below` is one name with `file` on a filesystem that
 * ignores letter case and Unicode form: `Docs` with `docs/x`, `a/B` with `A/b/c`, or (the same
 * spelling included) `a` with `a/b`. Such a tree cannot be written to that disk, whichever of the two
 * is written first. There is one pair for each folder of `below` that matches, and `file` is the first
 * of the paths given with that name. A path is never paired with itself.
 */
export function findFolderConflicts(
  paths: readonly string[],
): readonly (readonly [string, string])[] {
  // A tree of folded names, so that the folder of a path is a step down it and not a string made of
  // all the names above (which is quadratic in how deep a path goes). `owner` is the first path
  // whose folded name ends at that step.
  interface Step {
    owner: string | null;
    readonly below: Map<string, Step>;
  }
  const root: Step = { owner: null, below: new Map() };
  const folded = paths.map((path) => ({ path, parts: foldedParts(path) }));

  for (const { path, parts } of folded) {
    let step = root;
    for (const part of parts) {
      const next: Step = step.below.get(part) ?? { owner: null, below: new Map() };
      step.below.set(part, next);
      step = next;
    }
    step.owner ??= path;
  }

  const pairs: (readonly [string, string])[] = [];
  for (const { path, parts } of folded) {
    let step: Step | undefined = root;
    for (const part of parts.slice(0, -1)) {
      step = step.below.get(part);
      if (step === undefined) break;
      if (step.owner !== null) pairs.push([step.owner, path]);
    }
  }
  return pairs;
}
