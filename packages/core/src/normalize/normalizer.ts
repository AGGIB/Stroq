import type { VariantKind } from '../types.js';

export interface Variant {
  readonly kind: VariantKind;
  readonly depth: number;
  readonly text: string;
}

// Zero-width and invisible characters used to hide instructions: soft hyphen,
// zero-width space/joiners and bidi marks, invisible operators, BOM,
// variation selectors VS1-16 (U+FE00-FE0F) and their supplement VS17-256
// (U+E0100-E01EF), and Unicode tag characters (U+E0000-E007F, the "ASCII
// smuggling" block). \uD800-\uDFFF strips an unpaired (orphaned) surrogate;
// under the `u` flag a *paired* surrogate is matched as its single combined
// code point (e.g. an emoji, which is above 0xFFFF), so this never touches a
// real astral character -- only a half left over from a mangled encoding.
// The `u` flag is required for both that and the astral \u{...} range
// syntax.
const ZERO_WIDTH =
  /[\u00AD\u200B-\u200F\u2060-\u2064\uFE00-\uFE0F\uFEFF\uD800-\uDFFF\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
// Greek and Coptic (\u0370-\u03FF) plus Cyrillic (\u0400-\u04FF): the two
// non-Latin scripts covered by the HOMOGLYPHS table below. A token qualifies
// for folding only when it mixes one of these scripts with Latin \u2014 a token
// written wholly in Greek or Cyrillic is real text, not a disguise.
const NON_LATIN_CONFUSABLE = /[\u0370-\u03FF\u0400-\u04FF]/;
const LATIN = /[A-Za-z]/;
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic lookalikes
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  һ: 'h',
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  І: 'I',
  // Greek lookalikes -- unambiguous Latin mappings only
  ο: 'o',
  α: 'a',
  ε: 'e',
  ρ: 'p',
  γ: 'y',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  τ: 't',
  χ: 'x',
  // μ (U+03BC) has no fold, deliberately: NFKC rewrites the correct MICRO
  // SIGN (U+00B5, as in "240µs" or "10µF") onto this same codepoint before
  // the fold table runs, so mapping it to 'u' corrupts real text. The
  // fuzzer's Greek mutation table never emits μ either, so folding it never
  // convicted anything.
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
};

const BASE64_TOKEN = /[A-Za-z0-9+/]{24,}={0,2}/g;
const HEX_TOKEN = /\b(?:[0-9a-fA-F]{2}){16,}\b/g;
const URL_ENCODED = /%[0-9A-Fa-f]{2}[\s\S]*?%[0-9A-Fa-f]{2}/;
const MAX_TOKENS_PER_LAYER = 50;

function foldToken(token: string): string {
  if (!(NON_LATIN_CONFUSABLE.test(token) && LATIN.test(token))) return token;
  let out = '';
  for (const ch of token) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

interface NormalizePass {
  readonly text: string;
  readonly foldChanged: boolean;
}

// Runs strip+NFKC+fold once, and reports whether the *fold* stage itself
// changed anything -- not whether the pass as a whole did. See the loop
// below for why that distinction, evaluated here on the fold's own input
// and output rather than by re-running anything, is what the loop keys on.
function normalizeOnce(text: string): NormalizePass {
  const stripped = text.replace(ZERO_WIDTH, '').normalize('NFKC');
  let foldChanged = false;
  const folded = stripped
    .split(/(\s+)/)
    .map((token) => {
      const out = foldToken(token);
      if (out !== token) foldChanged = true;
      return out;
    })
    .join('');
  return { text: folded, foldChanged };
}

// Bounded so a pathological input can't loop unboundedly; three passes is
// generous headroom over the one pass this pipeline ever actually needs (see
// below).
const MAX_NORMALIZE_PASSES = 3;

// Re-runs strip+NFKC+fold until a pass's fold stage stops changing anything,
// instead of applying the pipeline once. As things stand this closes no live
// gap: a sweep of every Unicode code point (0..0x10FFFF, surrogates
// excluded) found that no character's NFKC expansion contains a zero-width
// character it did not already contain, and HOMOGLYPHS only ever emits
// plain ASCII, which strip and NFKC both leave untouched. That means strip
// and NFKC always produce terminal output -- neither stage can ever hand the
// other new work, today or after a change to either one -- and the fold is
// the only stage whose output is not terminal by construction, because it's
// also the only stage a future change (a fold that starts emitting
// non-ASCII) could make non-terminal. So the loop is keyed on the fold
// stage specifically, not on whether the pass as a whole changed the text:
// insurance against a future fold change, not a fix for an escape that
// exists now.
//
// This distinction is not academic. The strip and NFKC stages routinely
// change ordinary prose that has no fold-worthy content at all -- a single
// incidental NBSP (U+00A0), which NFKC folds to a plain space, is enough.
// Keying the loop on "did the pass change anything" (as an earlier version
// of this function did) treats that as proof the pipeline hasn't converged
// and pays for a full second pass to confirm it: on the 210 KB bench
// reference document, one such stray NBSP took normalizeText from ~3.06ms
// to ~6.22ms per call -- a second full pass over 210 KB to reconfirm a
// change neither strip nor NFKC could ever make again. Keying on the fold
// stage instead means benign prose, which folds nothing, pays for exactly
// one pass regardless of what strip or NFKC did to it.
export function normalizeText(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_NORMALIZE_PASSES; pass += 1) {
    const { text: next, foldChanged } = normalizeOnce(current);
    if (!foldChanged) return next;
    current = next;
  }
  return current;
}

function looksLikeText(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  let total = 0;
  for (const ch of s) {
    total += 1;
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || (c >= 160 && c !== 0xfffd))
      printable += 1;
  }
  return printable / total >= 0.9 && /[A-Za-z\u0400-\u04FF]{3}/.test(s);
}

function decodeBase64(token: string): string | null {
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  return looksLikeText(decoded) ? decoded : null;
}

function decodeHex(token: string): string | null {
  const decoded = Buffer.from(token, 'hex').toString('utf8');
  return looksLikeText(decoded) ? decoded : null;
}

function decodeUrl(text: string): string | null {
  if (!URL_ENCODED.test(text)) return null;
  try {
    const decoded = decodeURIComponent(text);
    return decoded !== text && looksLikeText(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function decodeLayer(text: string, depth: number, maxDepth: number): Variant[] {
  if (depth > maxDepth) return [];
  const found: Variant[] = [];
  const push = (kind: VariantKind, decoded: string | null): void => {
    if (decoded === null) return;
    found.push({ kind, depth, text: decoded });
    found.push(...decodeLayer(decoded, depth + 1, maxDepth));
  };
  for (const token of (text.match(BASE64_TOKEN) ?? []).slice(0, MAX_TOKENS_PER_LAYER)) {
    push('base64', decodeBase64(token));
  }
  for (const token of (text.match(HEX_TOKEN) ?? []).slice(0, MAX_TOKENS_PER_LAYER)) {
    push('hex', decodeHex(token));
  }
  push('url', decodeUrl(text));
  return found;
}

export function expandVariants(text: string, maxDepth = 2): Variant[] {
  const normalized = normalizeText(text);
  const base: Variant[] = [{ kind: 'raw', depth: 0, text }];
  if (normalized !== text) base.push({ kind: 'normalized', depth: 0, text: normalized });
  return [...base, ...decodeLayer(normalized, 1, maxDepth)];
}
