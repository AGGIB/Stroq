import { COLLAPSE_I, COLLAPSE_IU } from './case-fold-table.js';

/**
 * How a text and a literal are folded before one is looked for in the other:
 *
 * - `none`: the regex is case-sensitive; compared as they are.
 * - `i`: the `i` flag without `u`; the engine compares UTF-16 code units.
 * - `iu`: the `i` and `u` flags; the engine uses simple case folding over code points, under which
 *   U+017F (long s) is `s` and U+212A (the Kelvin sign) is `k`.
 */
export type FoldMode = 'none' | 'i' | 'iu';

/** The characters to turn into another after lower-casing, and what they turn into. */
interface Collapse {
  readonly pattern: RegExp;
  readonly target: ReadonlyMap<string, string>;
}

function collapseOf(groups: readonly (readonly number[])[]): Collapse {
  const target = new Map<string, string>();
  for (const [first, ...others] of groups)
    for (const code of others)
      target.set(String.fromCodePoint(code), String.fromCodePoint(first ?? 0));
  const members = [...target.keys()].map(
    (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`,
  );
  return { pattern: new RegExp(`[${members.join('')}]`, 'gu'), target };
}

const COLLAPSE: Readonly<Record<'i' | 'iu', Collapse>> = {
  i: collapseOf(COLLAPSE_I),
  iu: collapseOf(COLLAPSE_IU),
};

/**
 * The fold is `toLowerCase`, then the few characters it leaves apart that the engine equates are
 * made one (`COLLAPSE_*`, derived from the engine and checked against it by the tests).
 *
 * What makes this sound is a single property: two characters the regex engine takes as equal fold
 * to the same text. Then a text the regex matches, which holds a run equal character by character
 * to the literal, folds to a text that holds the folded literal. The fold may join more than the
 * engine does (it lower-cases an astral Deseret letter without `u`, where the engine would not),
 * and that only means a regex runs that did not have to.
 *
 * `toLowerCase` writes a capital sigma as a final sigma at the end of a word and as a medial one
 * elsewhere, so it is not a function of one character; both sigmas are in the table, which turns
 * the difference into nothing. No other lower-casing depends on its surroundings without a locale.
 */
export function foldText(mode: FoldMode, text: string): string {
  if (mode === 'none') return text;
  const { pattern, target } = COLLAPSE[mode];
  return text.toLowerCase().replace(pattern, (char) => target.get(char) ?? char);
}
