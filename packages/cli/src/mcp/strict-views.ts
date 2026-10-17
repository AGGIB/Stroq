import { isScannedMethod } from './framing.js';
import { resultTextFor } from './mcp-result-text.js';
import type { MediaPayloads } from './strict-leaves.js';
import { STRICT_MAX_TEXT_CHARS } from './strict-limits.js';

/**
 * The texts strict mode scans for one result, each on its own.
 *
 * A scanner reads a text, and what a rule can see depends on the text: its words side by
 * side, where it ends, what syntax it is in. No single text suits every rule. The default
 * proxy's text puts the blocks of a result on consecutive lines, which is how a sentence
 * spread over four content blocks stays a sentence; a list of every decoded string puts
 * a key on a line of its own between two values, which breaks that sentence and is also
 * the only text that holds EVERY string, which is what the post-condition proves; and a
 * rule written for JSON syntax wants JSON. So there are three views, scanned one after
 * the other, and a result is as suspect as its worst view:
 *
 * - `default`: exactly what the default proxy hands its scanner (`resultTextFor`, the
 *   reader the default proxy uses, unchanged), for the four methods it scans. Strict mode
 *   therefore scans at least what the default scans, by construction and not by a
 *   resemblance that has to be kept up;
 * - `strings`: every decoded string of the result, keys included, one per line
 *   (`strict-leaves.ts`); the text `isCovered` proves complete;
 * - `json`: the result as JSON, as far as the same 200,000-character window the default
 *   proxy clips its own text to. A string is not cut to a shorter length of its own, so a
 *   long value cannot push what follows it out of the text.
 *
 * They are separate texts rather than one joined text so that a rule anchored to the end
 * of a text (about thirty are, "a secret key:" with nothing after it) sees a text that
 * ends where the sentence does.
 */

export type ScanViewName = 'default' | 'strings' | 'json';

export interface ScanView {
  readonly name: ScanViewName;
  readonly text: string;
}

/**
 * `views` without the ones that add nothing: a view with no text, and a view whose text is
 * one an earlier view already has (scanning the same bytes twice would only double the
 * cost). The first of equal texts stays, so the order says which view found what.
 */
export function distinctViews(views: readonly ScanView[]): readonly ScanView[] {
  const seen = new Set<string>();
  const kept: ScanView[] = [];
  for (const view of views) {
    if (view.text === '' || seen.has(view.text)) continue;
    seen.add(view.text);
    kept.push(view);
  }
  return kept;
}

/**
 * The JSON view of `value`: its serialised form, the first `STRICT_MAX_TEXT_CHARS`
 * characters of it. Keys are kept (they are part of the JSON), and the payload of a
 * recognised media record is replaced by a fixed marker so the view keeps the shape
 * without carrying megabytes of base64. Plain `JSON.stringify` with a replacer: the
 * structure was already walked to its depth bound, so it cannot overflow the stack.
 */
export function jsonView(value: unknown, media: MediaPayloads): string {
  const json = JSON.stringify(value, function (this: unknown, key: string, member: unknown) {
    return typeof this === 'object' && this !== null && media.get(this) === key
      ? '[media]'
      : member;
  });
  return (json ?? '').slice(0, STRICT_MAX_TEXT_CHARS);
}

/** An empty object or array: nothing to read, and no JSON worth scanning. */
const isEmptyContainer = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.keys(value).length === 0;

/**
 * The views of `body`, the result (or error) object of a response to `method`; `null`
 * for an error object, which the default proxy never scans. `strings` is the text of the
 * decoded strings, already built (and checked) by the caller.
 *
 * A method the default proxy scans is always scanned at least once, even when it has
 * nothing in it, as it is there: an empty default view stands in when every view is empty.
 */
export function scanViews(
  method: string | null,
  body: unknown,
  strings: string,
  media: MediaPayloads,
): readonly ScanView[] {
  const scanned = method !== null && isScannedMethod(method) ? method : null;
  const defaultText = scanned === null ? '' : resultTextFor(scanned, body);
  const views = distinctViews([
    { name: 'default', text: defaultText },
    { name: 'strings', text: strings },
    { name: 'json', text: isEmptyContainer(body) ? '' : jsonView(body, media) },
  ]);
  if (views.length > 0 || scanned === null) return views;
  return [{ name: 'default', text: defaultText }];
}
