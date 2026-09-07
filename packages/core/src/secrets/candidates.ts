import { MIN_SECRET_LENGTH } from './extract.js';

/** One substring of a tool input that might be the value of a known secret. */
export interface SecretCandidate {
  /** The lookup form: URL-decoded when decoding changed the substring. */
  readonly token: string;
  /** The substring exactly as it appeared in the input, so it can be redacted. */
  readonly raw: string;
}

/**
 * Ceiling on ONE window of the text taken from a tool input. Bounding the INPUT
 * rather than the candidate count is what makes padding useless inside a window:
 * an attacker who could evict candidates by adding text would have a bypass, so
 * the only limit is on how much text one pass considers at all. The whole input
 * is read as a series of these, up to `MAX_SCAN_CHARS`.
 */
export const MAX_INPUT_CHARS = 262_144;
/**
 * Total text scanned across all windows: eight `MAX_INPUT_CHARS` windows. Text past
 * this is not scanned at all — the engine denies an egress-shaped action that
 * reaches it (`secret.unscannable`), so nothing beyond the bound is ever forwarded
 * on trust. Measured with this loop: 2 MiB of the densest padding tokenises in
 * ~180 ms, well inside every adapter's hook budget (10 s at the tightest).
 */
export const MAX_SCAN_CHARS = 2 * 1024 * 1024;
/**
 * Overlap between consecutive windows, so a value straddling a window boundary is
 * still seen whole by the later window. No credential comes near 4 KiB — the index
 * refuses whitespace-bearing values and `MIN_SECRET_LENGTH` is 12 — so this is a
 * generous margin, and the cost is one extra 4 KiB pass per window boundary.
 */
export const SCAN_OVERLAP = 4_096;
/**
 * Pure memory guard on the candidate list, not a security bound. The densest
 * measured padding yields ~0.15 candidates per input character, i.e. ~38k for
 * `MAX_INPUT_CHARS` of text; a full 2 MiB of it saturates this ceiling, which is
 * why it is a memory guard and never the thing that decides what gets looked up.
 */
export const MAX_CANDIDATES = 200_000;
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

/** `decodeURIComponent(span)` when it changes the value and doesn't throw, else `null`. */
function decodedVariant(span: string): string | null {
  if (!span.includes('%')) return null;
  try {
    const decoded = decodeURIComponent(span);
    return decoded !== span ? decoded : null;
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
 * Whole-value spans that survive even when the value itself contains a delimiter
 * character (`p@ss#w?rd:1234567`, a DSN, a header value): every word bounded by
 * whitespace or a quote mark, every quoted string's full content, and the tail
 * after each one's first `=` or `:`.
 */
function valueSpans(text: string): string[] {
  const level1 = [...quotedContents(text), ...text.split(WORD_BOUNDARY).filter((w) => w !== '')];
  return [...level1, ...level1.flatMap((s) => [...afterFirst(s, '='), ...afterFirst(s, ':')])];
}

/** Each span as a candidate, plus its URL-decoded form when decoding changes it. */
function withDecoded(spans: readonly string[]): SecretCandidate[] {
  return spans.flatMap((raw) => {
    const decoded = decodedVariant(raw);
    return decoded
      ? [
          { token: raw, raw },
          { token: decoded, raw },
        ]
      : [{ token: raw, raw }];
  });
}

/**
 * Substrings of a tool input that could be a secret value: whole value spans that
 * survive an embedded delimiter, plus the coarse/fine delimiter-split pieces (with
 * and without `/` and `@`), each paired with its URL-decoded form. Keeps pieces of
 * secret length and dedupes across every window.
 *
 * The text is read in `MAX_INPUT_CHARS` windows overlapping by `SCAN_OVERLAP`, up to
 * `MAX_SCAN_CHARS` in total, so padding cannot push a payload out of the result and
 * a value on a window boundary is still seen whole. An input longer than the bound
 * is scanned only to it; `exceedsSecretScan` reports that, and the engine denies
 * such an action rather than trusting a partial scan.
 */
export function candidateTokens(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): SecretCandidate[] {
  const text = textOf(toolName, toolInput);
  const limit = Math.min(text.length, MAX_SCAN_CHARS);
  const seen = new Set<string>();
  const out: SecretCandidate[] = [];
  for (let start = 0; start < limit; start += MAX_INPUT_CHARS) {
    const window = text.slice(
      Math.max(0, start - SCAN_OVERLAP),
      Math.min(start + MAX_INPUT_CHARS, limit),
    );
    if (window.trim() === '') continue;
    const coarse = window.split(DELIMITERS);
    const fine = coarse.flatMap((piece) => piece.split(SLASH));
    for (const candidate of withDecoded([...valueSpans(window), ...coarse, ...fine])) {
      const key = `${candidate.token}\n${candidate.raw}`;
      if (candidate.token.length < MIN_SECRET_LENGTH || seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

/**
 * True when the text this tool contributes is longer than the total scan bound, so
 * `candidateTokens` above saw only its first `MAX_SCAN_CHARS` characters. Shares the
 * module-private `textOf` with the tokeniser, so the two can never disagree about
 * what counts as the input — which is the whole point of it living here.
 */
export function exceedsSecretScan(
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): boolean {
  return textOf(toolName, toolInput).length > MAX_SCAN_CHARS;
}
