import type { SecretMatch } from '../types.js';
import type { CloakSpan } from './types.js';

/**
 * Turning the secret index's answer into spans — the part of this feature that had no
 * existing machinery, because `SecretMatch` says WHAT was found and never WHERE.
 *
 * The engine's own `redactMatches` has the same problem and solves it by brute force:
 * it replaces every spelling a value could wear — the raw substring, the URL-decoded
 * token, that token re-encoded, and the re-encoding with lowercase hex — without ever
 * computing a position. This does the same search, but records the positions it
 * actually finds instead of rewriting blind, which is what lets the result be merged
 * with the pattern spans and rewritten in one right-to-left pass.
 *
 * The rule that makes this safe: a span is emitted ONLY where `indexOf` really found
 * the literal. A match whose spellings do not occur in this text produces no span at
 * all, so no value is ever cut out at a guessed offset. (`SecretMatch.raw` is by
 * construction a substring of the text the candidates came from, so for the ordinary
 * case the search always succeeds; the other spellings are the ones that may not.)
 */

/** The same four spellings `redactMatches` rewrites, deduped and shortest-first-free. */
function spellings(match: SecretMatch): readonly string[] {
  const encoded = encodeURIComponent(match.token);
  const lowerEncoded = encoded.replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase());
  return [...new Set([match.raw, match.token, encoded, lowerEncoded])].filter((s) => s !== '');
}

/** `NAME (source)` — what a refusal may say about a value it will not restore. */
export const secretLabel = (match: SecretMatch): string => `${match.name} (${match.source})`;

/**
 * Every place in `text` where a known secret value appears, in any of its spellings.
 * Longer spellings are searched first so that an over-encoded form is preferred to a
 * shorter one nested inside it; overlaps among the results are resolved by the
 * caller's `mergeSpans`.
 */
export function secretSpans(text: string, matches: readonly SecretMatch[]): readonly CloakSpan[] {
  const spans: CloakSpan[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    for (const spelling of [...spellings(match)].sort((a, b) => b.length - a.length)) {
      for (let at = text.indexOf(spelling); at !== -1; at = text.indexOf(spelling, at + 1)) {
        const key = `${at}\n${spelling.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        spans.push({
          kind: 'secret',
          start: at,
          end: at + spelling.length,
          value: spelling,
          // A secret placeholder is never turned back into its value on the way out:
          // the model only ever saw the placeholder, so restoring it would hand this
          // machine's credential to the server, which is the thing the egress guard
          // exists to stop. The proxy refuses such a call instead.
          restorable: false,
          label: secretLabel(match),
        });
      }
    }
  }
  return spans;
}
