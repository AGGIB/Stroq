import { isScannedMethod } from './framing.js';
import { resultTextFor } from './mcp-result-text.js';
import { clippedCopy, type MediaPayloads } from './strict-leaves.js';

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
 * - `json`: the result as JSON.
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
    { name: 'json', text: isEmptyContainer(body) ? '' : clippedCopy(body, media) },
  ]);
  if (views.length > 0 || scanned === null) return views;
  return [{ name: 'default', text: defaultText }];
}
