// What a person needs to check a place that says a key was sent, or may have been: the call's own text
// with the value of every traced key taken out, and what linked the call to the key.
//
// The text is masked, never filtered: every spelling of every key the finder holds that the text contains is
// replaced by `[NAME]` (longest first, so a value that begins another leaves nothing of it), the shapes of
// tokens Stroq does not hold as keys by `[secret]`, blanks are folded to one space, every control character
// is written out as `\uXXXX`, and the text is cut to about `WINDOW` characters around the first replacement.
// A text that still holds a key's value, or six characters of one, after all that is not kept at all: the
// place keeps what linked the call to the key and no words.
import { neutralizeControls } from '@stroq/core';
import type { FoundKey, KeyFinder } from './keys.js';
import { shellJoined } from './needles.js';
import type { Evidence, Matched } from './place.js';
import { redactTokens } from './token-shapes.js';

/** The most characters of a call's text read for its evidence; past it the text is not kept. */
const MAX_READ = 200_000;
/** The characters kept around the first replacement, and how many of them come before it. */
export const WINDOW = 600;
const BEFORE = 200;

/** Marks a replacement while the text is worked on; no character of a call is left as one. */
const OPEN = '\u0001';
const CLOSE = '\u0002';

/** A key's name as a marker prints it: the shape of a name, else a fixed word. */
const NAME = /^[\w.@:/+-]{1,60}$/;
export const markerName = (name: string): string => (NAME.test(name) ? name : 'key');

/** The spelling of a key's value that a text holds. */
export function matchedForm(text: string, one: FoundKey): Matched {
  const value = one.key.value;
  if (text.includes(value)) return 'value';
  if (text.includes(JSON.stringify(value).slice(1, -1))) return 'value-json';
  try {
    if (text.includes(encodeURIComponent(value))) return 'value-url';
  } catch {
    // A lone surrogate has no URL spelling.
  }
  return 'value-joined';
}

/** A text cut to `WINDOW` characters starting `BEFORE` before `at`, with an ellipsis where it was cut. */
function around(text: string, at: number): string {
  const chars = [...text];
  if (chars.length <= WINDOW) return text;
  const index = at < 0 ? 0 : [...text.slice(0, at)].length;
  const start = Math.max(0, Math.min(index - BEFORE, chars.length - WINDOW));
  const end = Math.min(chars.length, start + WINDOW);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

/**
 * `text` masked and cut around `word` if it holds that, else around its first replacement, else from its
 * start. Null when the masked text is not safe to keep.
 */
export function maskedText(text: string, finder: KeyFinder, word = ''): string | null {
  if (text.length > MAX_READ) return null;
  const clean = text.split(OPEN).join('?').split(CLOSE).join('?');
  // A key a shell joins out of pieces is found in the joined text only: that is the text shown.
  const joined = shellJoined(clean);
  const direct = finder.find(clean);
  const viaJoined = joined === clean ? [] : finder.find(joined);
  const work = viaJoined.length > direct.length ? joined : clean;
  const found = viaJoined.length > direct.length ? viaJoined : direct;
  const forms = found
    .flatMap((one) => one.forms.map((form) => [form, markerName(one.key.name)] as const))
    .sort((a, b) => b[0].length - a[0].length);
  let out = work;
  for (const [form, name] of forms) out = out.split(form).join(`${OPEN}${name}${CLOSE}`);
  out = redactTokens(out, `${OPEN}secret${CLOSE}`).replace(/\s+/g, ' ').trim();
  const marker = new RegExp(`${OPEN}([^${CLOSE}]*)${CLOSE}`, 'g');
  const first = new RegExp(marker.source).exec(out)?.[1];
  const shown = neutralizeControls(out.replace(marker, '[$1]'));
  // What is left once the markers are taken out must hold no value and no piece of one. The markers are
  // names, which may well echo a key (`STRIPE_KEY` and `sk_live_…stripe…`): they are not looked at.
  const rest = out.replace(marker, ' ');
  if (finder.holds(rest) || finder.hasPiece(rest)) return null;
  const wordAt = word === '' ? -1 : shown.indexOf(word);
  const markAt = first === undefined ? -1 : shown.indexOf(`[${first}]`);
  return around(shown, wordAt >= 0 ? wordAt : markAt);
}

/** The last text masked: a call that holds many keys is masked once for all of them. */
let last: { finder: KeyFinder; text: string; word: string; shown: string | null } | null = null;

function maskedOnce(text: string, finder: KeyFinder, word: string): string | null {
  if (last?.finder === finder && last.text === text && last.word === word) return last.shown;
  const shown = maskedText(text, finder, word);
  last = { finder, text, word, shown };
  return shown;
}

/**
 * The evidence of a call for a key: the call's text masked, and what linked it. `word` is what named the
 * key's file, folder or pattern, or the variable it used; it is masked like the text, and left out if it
 * cannot be kept.
 */
export function evidenceFor(
  text: string,
  finder: KeyFinder,
  matched: Matched,
  word = '',
): Evidence {
  const safeWord = word === '' ? null : maskedText(word, finder);
  const shown = maskedOnce(text, finder, safeWord ?? '');
  return {
    text: shown ?? '',
    matched,
    ...(safeWord === null || safeWord === '' ? {} : { word: safeWord }),
  };
}
