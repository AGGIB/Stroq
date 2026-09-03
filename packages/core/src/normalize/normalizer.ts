import type { VariantKind } from '../types.js';

export interface Variant {
  readonly kind: VariantKind;
  readonly depth: number;
  readonly text: string;
}

// Zero-width and invisible characters used to hide instructions: soft hyphen,
// zero-width space/joiners and bidi marks, invisible operators, BOM,
// variation selectors (U+FE00-FE0F) and Unicode tag characters
// (U+E0000-E007F, the "ASCII smuggling" block). The `u` flag is required
// for the astral \u{...} range syntax.
const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060-\u2064\uFE00-\uFE0F\uFEFF\u{E0000}-\u{E007F}]/gu;
const CYRILLIC = /[\u0400-\u04FF]/;
const LATIN = /[A-Za-z]/;
const HOMOGLYPHS: Readonly<Record<string, string>> = {
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
};

const BASE64_TOKEN = /[A-Za-z0-9+/]{24,}={0,2}/g;
const HEX_TOKEN = /\b(?:[0-9a-fA-F]{2}){16,}\b/g;
const URL_ENCODED = /%[0-9A-Fa-f]{2}[\s\S]*?%[0-9A-Fa-f]{2}/;
const MAX_TOKENS_PER_LAYER = 50;

function foldToken(token: string): string {
  if (!(CYRILLIC.test(token) && LATIN.test(token))) return token;
  let out = '';
  for (const ch of token) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

export function normalizeText(text: string): string {
  return text.replace(ZERO_WIDTH, '').normalize('NFKC').split(/(\s+)/).map(foldToken).join('');
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
