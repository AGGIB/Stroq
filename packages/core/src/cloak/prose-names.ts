/**
 * Cloaking a name in PROSE, once the same result has already labelled it.
 *
 * `keyed.ts` claims `{"first_name":"Peter Parker"}` from the field it arrived in and
 * stops there, so `{"text":"call Peter about the invoice"}` in the very same result
 * travelled untouched. That is not a detection problem — the payload said who Peter
 * is, one field over — it is a problem of the detector being shown one leaf at a
 * time. This pass is the second look: the names a result labelled itself, searched
 * for in the leaves it did not label.
 *
 * The claim stays schema-backed, which is the point. Nothing here guesses that a
 * capitalised word is a person; it only finds again a person the server already
 * named. A name that appears ONLY in free text, with no field anywhere in the
 * result, is still not detected, and that is what an NER pass would be for.
 *
 * Two rules do the work, and both are about not blanking ordinary sentences:
 *
 *   - **Case-sensitive.** In prose a person is capitalised and a verb is not, so
 *     `mark the task as done` survives a customer called Mark.
 *   - **Sentence position, for the handful of names that are also ordinary words.**
 *     Capitalisation cannot separate them at the start of a sentence, where every
 *     word is capitalised, so there — and only there — a name from `ALSO_ORDINARY`
 *     is left alone.
 *
 * The cost of each rule runs one way and is worth stating: a name missed in prose is
 * still cloaked in the field that labelled it, so the model never learns it from the
 * labelled half; what is lost is the mention, not the record.
 */
import type { CloakSpan } from './types.js';

/**
 * Shortest part of a name worth looking for on its own. `Bo`, `Al` and `Jo` occur
 * inside ordinary text far more often than they occur as this person, and a
 * two-character needle across a long result is mostly noise.
 */
const MIN_PART_CHARS = 3;

/**
 * How many distinct strings one pass will look for. A result that labels more people
 * than this is a directory listing, and the work is bounded rather than left to grow
 * with whatever a server chose to return.
 */
export const MAX_NEEDLES = 64;

/**
 * Names that are also ordinary English words, which are therefore not claimed where
 * a sentence begins.
 *
 * The list is a cost control, not a safety mechanism, and it fails in the cheap
 * direction: an entry missing from it cloaks a word the agent wanted, while an entry
 * present in it lets one sentence-initial mention of a real person through — after
 * the field that named them has already been cloaked. Only words common enough to
 * start an ordinary sentence belong here; a rare collision is not worth the miss.
 */
const ALSO_ORDINARY: ReadonlySet<string> = new Set([
  'Amber',
  'Art',
  'Autumn',
  'Bill',
  'Bob',
  'Buck',
  'Carol',
  'Chase',
  'Chuck',
  'Daisy',
  'Dawn',
  'Don',
  'Drew',
  'Earl',
  'Faith',
  'Frank',
  'Grace',
  'Guy',
  'Hope',
  'Hunter',
  'Jack',
  'Joy',
  'June',
  'Major',
  'Mark',
  'Max',
  'May',
  'Mercy',
  'Nick',
  'Olive',
  'Page',
  'Pat',
  'Pearl',
  'Rose',
  'Ruby',
  'Sky',
  'Stone',
  'Sue',
  'Summer',
  'Wade',
  'Ward',
  'Will',
]);

/** Anything that is not a letter, a digit or an underscore, in any script. */
const NOT_WORD = '[^\\p{L}\\p{N}_]';

/** Characters after which the next word begins a sentence, or a line, or a bullet. */
const SENTENCE_END = new Set(['.', '!', '?', '\n', '\r', ';', ':', '•', '-', '*']);

const escapeLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The strings to look for, given the names a result labelled: each whole name, and
 * each of its parts long enough to stand alone.
 *
 * Longest first, because the alternation that uses them is leftmost-first: with
 * `Peter Parker` ahead of `Peter`, the full name wins wherever both would match, and
 * a single placeholder stands for the whole person rather than two abutting ones.
 */
export function nameNeedles(names: Iterable<string>): readonly string[] {
  const out = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed === '') continue;
    out.add(trimmed);
    for (const part of trimmed.split(/[^\p{L}\p{N}]+/u)) {
      if (part.length >= MIN_PART_CHARS) out.add(part);
    }
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, MAX_NEEDLES);
}

/** Whether the match at `index` sits where a sentence, line or list item begins. */
function startsSentence(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const char = text[i] ?? '';
    if (char === ' ' || char === '\t') continue;
    return SENTENCE_END.has(char);
  }
  return true;
}

/**
 * One compiled search for a set of names, reusable across every leaf of a result.
 *
 * Compiled once and not per leaf: this runs on the proxy's rewrite path, and a
 * result with a thousand string leaves would otherwise build a thousand identical
 * regular expressions before matching anything.
 */
export type NameMatcher = (text: string) => readonly CloakSpan[];

/** A matcher for `needles`, or null when there is nothing to look for. */
export function compileNameMatcher(needles: readonly string[]): NameMatcher | null {
  if (needles.length === 0) return null;
  // Boundaries by what is NOT a word character in ANY script, rather than by `\b`,
  // which is defined over ASCII word characters alone and would cut `Ааронов` in
  // half. The alternation is of literals only, so it stays linear whatever a server
  // put in a name field.
  const source = `(?<=^|${NOT_WORD})(?:${needles.map(escapeLiteral).join('|')})(?=$|${NOT_WORD})`;
  return (text: string): readonly CloakSpan[] => {
    if (text === '') return [];
    const spans: CloakSpan[] = [];
    for (const match of text.matchAll(new RegExp(source, 'gu'))) {
      const value = match[0];
      const start = match.index;
      if (ALSO_ORDINARY.has(value) && startsSentence(text, start)) continue;
      spans.push({ kind: 'name', start, end: start + value.length, value, restorable: true });
    }
    return spans;
  };
}

/**
 * Every occurrence of a known name in `text`, as spans into that exact string.
 *
 * Restorable, like every other name: the model acts on a placeholder and the server
 * receives the real value back, which is what keeps the agent's work working.
 */
export function detectKnownNames(text: string, needles: readonly string[]): readonly CloakSpan[] {
  return compileNameMatcher(needles)?.(text) ?? [];
}
