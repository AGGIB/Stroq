import { expandVariants, normalizeText } from '../normalize/normalizer.js';
import { decodePercentRuns } from '../normalize/percent-runs.js';
import { candidatesFromText, type SecretCandidate } from '../secrets/candidates.js';
import type { Atom, SecretMatch } from '../types.js';

/**
 * Taking known secret values out of the text a provenance record keeps.
 *
 * An atom is a slice of a tool result, and a result can echo a credential: a URL with a
 * token in its query, a package name a page built from one. Provenance stores the atom's
 * excerpt on disk to show the user later, so it is scrubbed as an audit summary is. What
 * makes it harder than a summary is that an atom is not the text as written. It is cut from
 * normalised text and from the base64, hex and percent-decoded layers of it, so a value
 * appears in it lowercased, without its trailing punctuation, with compatibility characters
 * and look-alike letters folded, percent-encoded in whichever characters the writer chose,
 * or inside a blob that decodes to it.
 */

/**
 * `text` with each run of valid percent-escapes decoded on its own and an invalid one left
 * as it was. The scanner's own percent layer decodes the whole text at once and drops the
 * layer on the first bad escape, and it has to stay that way: read leniently, the same
 * layer flagged seven more of the benign documents in `stroq bench` (14.9% to 20.7%).
 * Looking for a KNOWN VALUE has no such cost, so here a stray `50%` does not hide the
 * escapes beside it.
 */
export const percentDecodedLeniently = decodePercentRuns;

/**
 * Every secret-index candidate in `text` and in each form `expandVariants` reads from it,
 * each also read with its percent-escapes decoded leniently.
 */
export const candidatesOfVariants = (text: string): SecretCandidate[] =>
  expandVariants(text).flatMap((variant) => {
    const lenient = percentDecodedLeniently(variant.text);
    return lenient === variant.text
      ? candidatesFromText(variant.text)
      : [...candidatesFromText(variant.text), ...candidatesFromText(lenient)];
  });

/** More distinct spellings than this and the excerpts are withheld rather than checked. */
export const MAX_EXCERPT_FORMS = 512;
/** A spelling shorter than this is not redacted: it would be found inside other text. */
const MIN_SPELLING_CHARS = 6;
/** The same for a value with its tail cut off, which is more likely to be an ordinary word. */
const MIN_TAIL_SPELLING_CHARS = 10;
/** What prose and URLs put after a value that is not part of it, and base64 padding. */
const VALUE_TAIL = '.,;:!?\'")]}>`=';
/** A run that could be a base64 or hex blob: what fits inside one atom. */
const BLOB_RUN = /[A-Za-z0-9+/_-]{16,600}={0,2}/g;
const MAX_BLOB_RUNS = 500;

/** `value` without the characters of `tail` at its end, in one pass (no regex to restart). */
function withoutTail(value: string, tail: string): string {
  let end = value.length;
  while (end > 0 && tail.includes(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}

/** The name of a known value that `value`, or something it decodes to, holds. */
function knownNameIn(value: string, known: ReadonlyMap<string, string>): string | undefined {
  for (const candidate of candidatesOfVariants(value)) {
    const name = known.get(candidate.token);
    if (name !== undefined) return name;
  }
  return undefined;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The function that scrubs one atom, built once per tool result: every spelling of every
 * known value that was found in it, compiled into a single case-insensitive alternation
 * (longest first) and applied in one pass, so a replacement is never rescanned. Redacting
 * one value at a time did rescan them, and a later value that was a fragment of an earlier
 * marker corrupted it; and it cost matches x atoms x spellings regexes, built each time,
 * with no bound.
 *
 * Returns `null` when there are more spellings than `MAX_EXCERPT_FORMS`: the caller withholds
 * the excerpts, which fails closed on the excerpt and keeps the record.
 */
export function excerptRedactor(
  text: string,
  matches: readonly SecretMatch[],
): ((atom: Atom) => string) | null {
  const names = new Map<string, string>();
  const known = new Map<string, string>();
  const add = (form: string, name: string): void => {
    const key = form.toLowerCase();
    if (key !== '' && !names.has(key)) names.set(key, name);
  };

  for (const match of matches) {
    known.set(match.token, match.name);
    const encoded = encodeURIComponent(match.token);
    const lowerEncoded = encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
    for (const form of [match.raw, match.token, encoded, lowerEncoded]) add(form, match.name);
    for (const form of new Set([match.raw, match.token])) {
      for (const base of new Set([form, withoutTail(form, VALUE_TAIL)])) {
        const floor = base === form ? MIN_SPELLING_CHARS : MIN_TAIL_SPELLING_CHARS;
        if (base.length < floor) continue;
        // In the context of the letters around it: a look-alike letter folds only beside Latin ones.
        for (const spelling of [
          base,
          normalizeText(`a${base}`).slice(1),
          normalizeText(`a?${base}&`).slice(2, -1),
        ])
          if (spelling.length >= MIN_SPELLING_CHARS) add(spelling, match.name);
      }
    }
  }

  // A blob glued into a URL is part of a url atom, not an `encoded` atom, and it is the
  // blob that has to go: it is not spelled like the value it decodes to.
  const runs = new Set(text.match(BLOB_RUN) ?? []);
  let examined = 0;
  for (const run of runs) {
    if (examined >= MAX_BLOB_RUNS) break;
    examined += 1;
    const name = knownNameIn(run, known);
    if (name !== undefined) add(run, name);
  }

  if (names.size > MAX_EXCERPT_FORMS) return null;
  const forms = [...names.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(forms.map(escapeRegExp).join('|'), 'gi');
  const checkable = forms.filter((form) => form.length >= MIN_SPELLING_CHARS);

  return (atom) => {
    if (atom.kind === 'encoded' && knownNameIn(atom.value, known) !== undefined)
      return '[REDACTED:encoded-secret]';
    const out = atom.value.replace(
      pattern,
      (found) => `[REDACTED:${names.get(found.toLowerCase()) ?? 'secret'}]`,
    );
    // Percent-encoded in some characters and not others, or in a spelling none of the forms
    // above has: what is left, decoded, must not hold a value.
    const decoded = percentDecodedLeniently(out).toLowerCase();
    return checkable.some((form) => decoded.includes(form)) ? '[REDACTED:secret]' : out;
  };
}
