import { describe, expect, it } from 'vitest';
import { cpuNow } from '../../../core/test/cpu-time.js';
import { findCollisions, findFolderConflicts } from '../../src/install/path-collision.js';
import {
  checkEntryPath,
  isWellFormed,
  quotePath,
  stripTopComponent,
} from '../../src/install/safe-path.js';
import { buildTree } from '../../src/install/tree.js';
import { LIMITS } from '../../src/install/types.js';
import { fileEntry } from '../helpers/install-tree.js';

/**
 * The names in an archive are written by whoever made the archive, and they reach this code before
 * anything has been decided about them. A pattern that goes super-linear on some name, or a
 * normalisation that does (`String.prototype.normalize` is quadratic on a long run of combining marks
 * of alternating classes: 4,096 of them take 12 ms, 65,536 take three seconds), would let a name of a
 * few hundred kilobytes hold the process for minutes, and the check that was meant to refuse it would
 * be the thing that hangs. So every entry point that takes a path is timed on text built to be slow,
 * at three sizes, in processor time (never the wall clock, which a sleeping laptop or a busy runner
 * bends).
 *
 * What is held is the growth, not a number of milliseconds: each shape is timed at a sixteenth of the
 * top size, a quarter of it and all of it, and each time is compared with the one before. Linear work
 * takes about four times as long for four times the text; a quadratic pattern takes sixteen. Only a
 * time that is both slow and growing faster than it should fails: a time alone does not work on a
 * shared runner, and a ratio alone does not work on timings of a millisecond, which are noise. A size
 * that looks too slow is timed again, twice, and the least is kept, because noise only adds.
 *
 * It replaces a test that ran each shape once at the longest size the check reads and asked only
 * whether the answer was a boolean, which cannot fail on a pattern that is slow but finishes.
 */
const SIZE = 64 * 1024;
const SIZES = [SIZE / 16, SIZE / 4, SIZE] as const;
/** A time under this is not slow, however much it grew. The slowest case below takes about 3 s when it is quadratic. */
const BOUND_MS = 500;
/** What a quadruple of the text may cost in times: linear work is about 4, quadratic work 16. */
const MAX_GROWTH = 11;
/** How often a size that looks too slow is timed, the first time included. */
const TRIES = 3;

/** `unit`, repeated to fill `size` UTF-16 units. */
const repeat =
  (unit: string) =>
  (size: number): string =>
    unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

type Shape = (size: number) => string;

const SHAPES: readonly (readonly [name: string, shape: Shape])[] = [
  // Near misses of the rules for names: each is a prefix of a name that is refused, repeated.
  ['dots', repeat('.')],
  ['spaces', repeat(' ')],
  ['con', repeat('con')],
  ['git~', repeat('git~')],
  ['.gi', repeat('.gi')],
  ['a:', repeat('a:')],
  ['a/', repeat('a/')],
  ['COM', repeat('COM')],
  ['./', repeat('./')],
  ['an escape of Windows characters', repeat('a?*<>|"')],
  // Combining marks. One class is already in order; alternating classes are not, and that is the
  // shape that the normalisation is quadratic on.
  ['combining marks of one class', (size) => `e${repeat('\u0301')(size - 1)}`],
  ['combining marks of alternating classes', (size) => `e${repeat('\u0301\u0316')(size - 1)}`],
  ['combining marks of descending classes', (size) => `e${repeat('\u0301\u0321\u0316')(size - 1)}`],
  ['combining marks between slashes', repeat('a\u0301\u0316/')],
  ['Hangul jamo, which compose', repeat('\u1100\u1161\u11a8')],
  // Characters that change length when they are folded.
  ['sharp s', repeat('\u00df')],
  // The one letter that the fold needs a second round for.
  ['capital sharp s', repeat('\u1e9e')],
  ['final sigma', repeat('\u03a3')],
  ['capital I with a dot', repeat('\u0130')],
  ['n with a preceding apostrophe', repeat('\u0149')],
  ['ligatures that expand under NFKC', repeat('\ufb03')],
  ['the longest expansion under NFKC', repeat('\ufdfa')],
  // What is refused for what it is.
  ['zero-width spaces', repeat('\u200b')],
  ['direction overrides', repeat('\u202e')],
  ['tag characters', repeat('\u{e0041}')],
  ['lone surrogates', repeat('\ud800')],
  ['astral characters', repeat('\u{1f600}')],
  ['NULs', repeat('\u0000')],
];

type EntryPoint = (text: string) => unknown;

const ENTRY_POINTS: readonly (readonly [name: string, run: EntryPoint])[] = [
  ['checkEntryPath', (text) => checkEntryPath(text)],
  ['quotePath', (text) => quotePath(text)],
  ['isWellFormed', (text) => isWellFormed(text)],
  ['findCollisions', (text) => findCollisions([text, text.toUpperCase(), `${text}/x`])],
  ['findFolderConflicts', (text) => findFolderConflicts([text, `${text}/x`, text.toUpperCase()])],
  ['stripTopComponent', (text) => stripTopComponent([`top/${text}`, `top/${text}/y`])],
];

const timed = (run: () => unknown): number => {
  const started = cpuNow();
  run();
  return cpuNow() - started;
};

/**
 * Times `run` on each of `inputs`, smallest first and each four times the one before, and fails if a
 * time is both slow (over `BOUND_MS`) and more than `MAX_GROWTH` times the one before it.
 */
function expectLinear<T>(
  inputs: readonly T[],
  labels: readonly string[],
  run: (input: T) => unknown,
): void {
  const times: number[] = [];
  for (const input of inputs) {
    const before = times[times.length - 1];
    let took = timed(() => run(input));
    for (
      let tries = 1;
      tries < TRIES && before !== undefined && took >= BOUND_MS && took >= MAX_GROWTH * before;
      tries += 1
    ) {
      took = Math.min(
        took,
        timed(() => run(input)),
      );
    }
    times.push(took);
  }

  const growth = times.map((ms, i) => `${ms.toFixed(1)} ms at ${labels[i] ?? '?'}`);
  for (let i = 1; i < times.length; i += 1) {
    const small = times[i - 1] ?? 0;
    const big = times[i] ?? 0;
    expect(big < BOUND_MS || big < MAX_GROWTH * small, growth.join(', ')).toBe(true);
  }
}

describe('the path code stays linear on text built to be slow', () => {
  const labels = SIZES.map((size) => `${size / 1024} KiB`);

  describe.each(ENTRY_POINTS)('%s', (_name, run) => {
    it.each(SHAPES)('%s', (_shape, build) => {
      expectLinear(
        SIZES.map((size) => build(size)),
        labels,
        run,
      );
    });
  });
});

// The tree meets the paths in bulk: thousands of them, each as hostile as a path may be, and it folds
// each of them more than once. What grows here is the number of entries, so the work must grow as
// fast as that and no faster.
describe('a tree of hostile names stays linear in the number of entries', () => {
  const COUNTS = [LIMITS.maxEntries / 16, LIMITS.maxEntries / 4, LIMITS.maxEntries].map(Math.floor);
  const labels = COUNTS.map((count) => `${count} entries`);
  const name = (i: number): string => i.toString(36);

  const NAMES: readonly (readonly [what: string, path: (i: number) => string])[] = [
    // 200 bytes of marks that the normalisation has to put in order, in every name.
    ['marks of alternating classes', (i) => `${name(i)}e${'\u0301\u0316'.repeat(50)}`],
    ['marks between letters', (i) => `${name(i)}${'a\u0301\u0316'.repeat(30)}`],
    ['names that change length when folded', (i) => `${name(i)}${'\u00df\u03a3\u0130'.repeat(20)}`],
    ['names that need a second round of the fold', (i) => `${name(i)}${'\u1e9e'.repeat(60)}`],
    ['the deepest folders', (i) => `${'d/'.repeat(LIMITS.maxDepth - 2)}${name(i)}`],
    ['a folder to each entry', (i) => `${name(i)}/${name(i)}`],
  ];

  it.each(NAMES)('%s', (_what, path) => {
    const trees = COUNTS.map((count) =>
      Array.from({ length: count }, (_, i) => fileEntry(path(i), 'x')),
    );

    expectLinear(trees, labels, (entries) => buildTree(entries));
  });
});

// A path longer than the limit is refused before it is read, so the patterns inside the check only
// ever see this much. An exponential pattern would not finish on it, and one that is only slow would
// show here as a time far above what a few dozen tests of this size take. The bound is a time, so it
// is generous: about a thousand times what the check takes.
describe('a path as long as the limit is answered at once', () => {
  const CALLS = 200;
  const PER_SHAPE_MS = 250;

  it.each(SHAPES)('%s', (_shape, build) => {
    const text = build(LIMITS.maxPathBytes);

    const best = Math.min(
      ...Array.from({ length: TRIES }, () =>
        timed(() => {
          for (let call = 0; call < CALLS; call += 1) checkEntryPath(text);
        }),
      ),
    );

    expect(best, `${best.toFixed(1)} ms for ${CALLS} calls`).toBeLessThan(PER_SHAPE_MS);
  });
});
