import { foldText, type FoldMode } from './case-fold.js';
import type { TextIndexes } from './text-index.js';

/**
 * A cheap test that is false only for texts a regex cannot match.
 *
 * `literals` are folded as `fold` says. Every text the regex matches holds, once folded the same
 * way, at least one of them. So a text that holds none of them is not matched, and the regex need
 * not run. It says nothing the other way: a text that holds one may still not match.
 */
export interface Prefilter {
  readonly fold: FoldMode;
  readonly literals: readonly string[];
}

/**
 * The shortest literal worth looking for. A literal of one or two characters is in most texts, so
 * looking for it costs and rarely saves. A regex whose best requirement is shorter has no prefilter.
 */
export const MIN_LITERAL_LENGTH = 3;

/** The literals each condition of a rule requires, in order; null where it requires none. */
export type RuleLiterals = readonly (readonly string[] | null)[];

/** Rule id to the literals of its conditions. See `prefilterTable`. */
export type PrefilterTable = Readonly<Record<string, RuleLiterals>>;

/** Half of a surrogate pair without its other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** How the engine will compare case for a regex compiled with `flags`. */
export function foldModeOf(flags: string): FoldMode {
  if (!flags.includes('i')) return 'none';
  return flags.includes('u') ? 'iu' : 'i';
}

/**
 * The prefilter for a regex compiled with `flags` whose source requires `required` (from
 * `requiredLiterals`), or `undefined` when there is nothing worth looking for.
 */
export function buildPrefilter(
  required: readonly string[] | null,
  flags: string,
): Prefilter | undefined {
  if (required === null || required.length === 0) return undefined;
  const fold = foldModeOf(flags);
  // Under `i` without `u` the engine reads code units, so a literal's lone half of a surrogate
  // pair matches half of a pair in the text; lower-casing the text changes that pair as a whole
  // (U+10400 to U+10428), and the folded literal would no longer be found in it.
  if (fold === 'i' && required.some((literal) => LONE_SURROGATE.test(literal))) return undefined;
  const literals = [...new Set(required.map((literal) => foldText(fold, literal)))];
  if (literals.some((literal) => literal.length < MIN_LITERAL_LENGTH)) return undefined;
  return { fold, literals };
}

/** Whether `text` could be matched by the regex `prefilter` was built for. */
export function mayMatch(prefilter: Prefilter, text: string, indexes: TextIndexes): boolean {
  const index = indexes.of(text);
  return prefilter.literals.some((literal) => index.holds(prefilter.fold, literal));
}
