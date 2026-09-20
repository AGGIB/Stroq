import type { CloakKind, CloakSpan } from './types.js';

/**
 * Turning spans into text, and back. Everything here is pure: the dictionary that
 * decides WHICH placeholder a value gets lives in `store.ts`, because it is I/O.
 */

/**
 * The placeholder shape. Deliberately ASCII, short, bracketed and prefixed: the model
 * has to reproduce it verbatim in a later `tools/call` for the round trip to close,
 * so an exotic character or a long opaque id is a transcription error waiting to
 * happen. The `STROQ_` prefix is what keeps it from colliding with the square-bracket
 * conventions real content uses (`[1]`, `[TODO]`, `[object Object]`), and every mint
 * additionally checks the literal against the text it is about to be written into.
 */
export const mintPlaceholder = (kind: CloakKind, seq: number): string =>
  `[STROQ_${kind.toUpperCase()}_${seq}]`;

/** Matches one placeholder. Used to find every one a client line carries. */
export const PLACEHOLDER_RE = /\[STROQ_[A-Z]+_\d{1,9}\]/g;

/** Every distinct placeholder occurring in `text`, in first-seen order. */
export function findPlaceholders(text: string): readonly string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags))) {
    seen.add(m[0]);
  }
  return [...seen];
}

/**
 * Spans in position order with every overlap removed, keeping the stronger claim.
 *
 * A `secret` span wins any overlap outright: it is the value of a credential this
 * machine actually holds, which is a fact, while every other kind is a shape. After
 * that the earlier start wins, then the longer span — an email that happens to begin
 * with a card-shaped digit run is an email, not a card followed by a domain.
 */
export function mergeSpans(spans: readonly CloakSpan[]): readonly CloakSpan[] {
  const rank = (span: CloakSpan): number => (span.kind === 'secret' ? 0 : 1);
  const ordered = [...spans].sort(
    (a, b) => a.start - b.start || rank(a) - rank(b) || b.end - a.end,
  );
  // A secret that starts LATER than an overlapping pattern span still has to win, so
  // secrets are laid down first and the rest only fill the gaps left over.
  const kept: CloakSpan[] = [];
  const fits = (span: CloakSpan): boolean =>
    kept.every((other) => span.end <= other.start || span.start >= other.end);
  for (const span of ordered) if (span.kind === 'secret' && fits(span)) kept.push(span);
  for (const span of ordered) if (span.kind !== 'secret' && fits(span)) kept.push(span);
  return kept.sort((a, b) => a.start - b.start);
}

/** One substitution that was actually written into the text. Never carries the value. */
export interface CloakReplacement {
  readonly kind: CloakKind;
  readonly placeholder: string;
  readonly restorable: boolean;
}

export interface Substitution {
  readonly text: string;
  readonly replacements: readonly CloakReplacement[];
}

/**
 * Replaces each span with the placeholder `placeholderFor` returns for it, walking
 * RIGHT TO LEFT so that every offset still describes the string the span was found
 * in: rewriting left to right would shift every later span by the length difference
 * of the ones before it, which is precisely the class of bug that turns a privacy
 * feature into data corruption.
 *
 * `spans` must already be overlap-free and sorted — `mergeSpans` guarantees both.
 */
export function applySpans(
  text: string,
  spans: readonly CloakSpan[],
  placeholderFor: (span: CloakSpan) => string,
): Substitution {
  if (spans.length === 0) return { text, replacements: [] };
  const replacements: CloakReplacement[] = [];
  let out = text;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i]!;
    const placeholder = placeholderFor(span);
    out = out.slice(0, span.start) + placeholder + out.slice(span.end);
    replacements.push({ kind: span.kind, placeholder, restorable: span.restorable });
  }
  // Reversed back into reading order, so an audit entry lists them the way the text does.
  return { text: out, replacements: replacements.reverse() };
}

/**
 * Replaces every occurrence of each known placeholder with its value. A placeholder
 * `values` does not know is left exactly as it is: an unknown placeholder means the
 * dictionary expired, was cleared, or never held it, and forwarding the literal text
 * is the failure that cannot leak. `split`/`join` rather than `replace`, so nothing in
 * a value is ever read as a replacement pattern (`$&`, `$1`).
 */
export function restore(
  text: string,
  values: ReadonlyMap<string, string>,
): { readonly text: string; readonly restored: readonly string[] } {
  const restored: string[] = [];
  let out = text;
  for (const [placeholder, value] of values) {
    if (!out.includes(placeholder)) continue;
    out = out.split(placeholder).join(value);
    restored.push(placeholder);
  }
  return { text: out, restored };
}
