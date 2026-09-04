import { MIN_SECRET_LENGTH } from './extract.js';

/** Upper bound on tokens hashed per event. */
export const MAX_CANDIDATES = 500;
// Shell, JSON and URL delimiters. `/` and `@` are deliberately absent here because
// secret values can contain them (an AWS-style key, a `p@ssw0rd`-style password); a
// second pass below splits on both instead, so the whole token is still a candidate.
const DELIMITERS = /[\s"'`=:&?,;()[\]{}<>|\\#]+/;
const SLASH = /[/@]/;
// Whitespace or a quote mark: bounds a "word" span so a quoted value's words
// (and a value glued against a quote) surface without a stray quote attached.
const WORD_BOUNDARY = /[\s"'`]+/;
// Linear (no nested quantifiers) extraction of quoted-string content: each
// alternative is one bounded `[^X]*` run between a matching pair of `X`.
const QUOTED = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;

function textOf(toolName: string, toolInput: Readonly<Record<string, unknown>>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (toolName === 'Bash') return str(toolInput['command']);
  if (toolName === 'WebFetch') return `${str(toolInput['url'])} ${str(toolInput['prompt'])}`;
  if (toolName.startsWith('mcp__')) return JSON.stringify(toolInput);
  return '';
}

/** `decodeURIComponent(token)` when it changes the value and doesn't throw, else `null`. */
function decodedVariant(token: string): string | null {
  if (!token.includes('%')) return null;
  try {
    const decoded = decodeURIComponent(token);
    return decoded !== token ? decoded : null;
  } catch {
    return null;
  }
}

/** Content of every double-, single- and backtick-quoted span in `text`, quotes stripped. */
function quotedContents(text: string): string[] {
  return [...text.matchAll(QUOTED)].flatMap((m) => {
    const content = m[1] ?? m[2] ?? m[3] ?? '';
    return content === '' ? [] : [content];
  });
}

/** The tail of `span` after its first `sep`, or nothing if `sep` doesn't occur. */
function afterFirst(span: string, sep: string): string[] {
  const i = span.indexOf(sep);
  return i >= 0 ? [span.slice(i + 1)] : [];
}

/**
 * Whole-value candidates that survive even when the value itself contains a
 * delimiter character (`p@ss#w?rd:1234567`, a DSN, a header value): every
 * word bounded by whitespace or a quote mark, every quoted string's full
 * content, the tail after each one's first `=` or `:`, and the URL-decoded
 * form of any of those. Pushed ahead of the delimiter-split pieces in
 * `candidateTokens` so they are not crowded out by `MAX_CANDIDATES`.
 */
function valueSpans(text: string): string[] {
  const level1 = [...quotedContents(text), ...text.split(WORD_BOUNDARY).filter((w) => w !== '')];
  const tails = level1.flatMap((s) => [...afterFirst(s, '='), ...afterFirst(s, ':')]);
  const spans = [...level1, ...tails];
  const decoded = spans.flatMap((s) => {
    const variant = decodedVariant(s);
    return variant ? [variant] : [];
  });
  return [...spans, ...decoded];
}

/**
 * Substrings of a tool input that could be a secret value: whole value spans
 * that survive an embedded delimiter, plus the coarse/fine delimiter-split
 * pieces (with and without `/` and `@`), plus URL-decoded forms of either.
 * Keeps pieces of secret length, dedupes, caps.
 */
export function candidateTokens(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): string[] {
  const text = textOf(toolName, toolInput);
  if (text.trim() === '') return [];
  const coarse = text.split(DELIMITERS);
  const fine = coarse.flatMap((piece) => piece.split(SLASH));
  const raw = [...coarse, ...fine];
  const decoded = raw.flatMap((token) => {
    const variant = decodedVariant(token);
    return variant ? [variant] : [];
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of [...valueSpans(text), ...raw, ...decoded]) {
    if (token.length < MIN_SECRET_LENGTH || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
