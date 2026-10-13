/**
 * Brace expansion, as a shell does it to a word before any command sees it: `{a,b}` is two words,
 * `x{1..3}` is three, and `{~,/tmp/x}` is the home directory and a path. A command written with
 * one has several targets that its text does not show one by one, so a check that reads targets
 * has to look at each of them.
 *
 * Bounded in the number of words it makes: a word like `{a,b}{a,b}{a,b}…` grows as a power, and
 * this is read inside a hook that cannot wait for it.
 */

/** The most words one brace expansion may make before it is not read any further. */
export const MAX_BRACE_WORDS = 64;

/**
 * The index just past the stretch a shell reads as one piece of text, with no brace in it that is
 * one, that begins at `at`: a quote, `$'…'`, a pair of backticks, a `$(…)`. -1 where none begins.
 */
function opaqueEnd(text: string, at: number): number {
  const ch = text.charAt(at);
  if (ch === "'") {
    const close = text.indexOf("'", at + 1);
    return close === -1 ? text.length : close + 1;
  }
  const escapes = ch === '"' || ch === '`' || (ch === '$' && text.charAt(at + 1) === "'");
  if (escapes) {
    const quote = ch === '$' ? "'" : ch;
    for (let i = at + (ch === '$' ? 2 : 1); i < text.length; i += 1) {
      if (text.charAt(i) === '\\') i += 1;
      else if (text.charAt(i) === quote) return i + 1;
    }
    return text.length;
  }
  if (ch === '$' && text.charAt(at + 1) === '(') {
    let depth = 0;
    for (let i = at + 1; i < text.length; i += 1) {
      if (text.charAt(i) === '(') depth += 1;
      else if (text.charAt(i) === ')' && (depth -= 1) === 0) return i + 1;
    }
    return text.length;
  }
  return -1;
}

/** The alternatives of the text between a pair of braces, or null when it is not an expansion. */
function alternatives(inner: string, quoted: boolean): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner.charAt(i);
    const opaque = quoted ? opaqueEnd(inner, i) : -1;
    if (opaque !== -1) i = opaque - 1;
    else if (ch === '\\') i += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  if (parts.length > 0) return [...parts, inner.slice(from)];
  return range(inner);
}

/** `1..3` and `a..e`: the words of a sequence, or null when the text is not one. */
function range(inner: string): string[] | null {
  const match = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
  if (match === null) return null;
  const numeric = /^-?\d+$/.test(match[1] as string);
  if (numeric !== /^-?\d+$/.test(match[2] as string)) return null;
  const from = numeric ? Number(match[1]) : (match[1] as string).charCodeAt(0);
  const to = numeric ? Number(match[2]) : (match[2] as string).charCodeAt(0);
  const step = Math.max(1, Math.abs(Number(match[3] ?? 1)));
  const words: string[] = [];
  const direction = from <= to ? 1 : -1;
  for (let n = from; direction === 1 ? n <= to : n >= to; n += direction * step) {
    if (words.length > MAX_BRACE_WORDS) break;
    words.push(numeric ? String(n) : String.fromCharCode(n));
  }
  // A zsh, and a bash since 4, pad `{01..03}` to the width it was written in: `01`, `02`, `03`.
  // An older bash does not, so what is padded and what is not are both words.
  const width = numeric
    ? Math.max(zeroPadded(match[1] as string), zeroPadded(match[2] as string))
    : 0;
  if (width === 0) return words;
  const padded = words.map((word) =>
    word.replace(
      /^(-?)(\d+)$/,
      (_all, sign: string, digits: string) => `${sign}${digits.padStart(width, '0')}`,
    ),
  );
  return [...new Set([...padded, ...words])];
}

/** The width a number was written with when it begins with a zero (`01`, `-001`), or 0. */
function zeroPadded(text: string): number {
  const digits = text.replace(/^-/, '');
  return digits.length > 1 && digits.startsWith('0') ? digits.length : 0;
}

/** The index of the `}` that closes the `{` at `open`, or -1. */
function closing(word: string, open: number, quoted: boolean): number {
  let depth = 0;
  for (let i = open; i < word.length; i += 1) {
    const ch = word.charAt(i);
    const opaque = quoted ? opaqueEnd(word, i) : -1;
    if (opaque !== -1) i = opaque - 1;
    else if (ch === '\\') i += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The next `{` at or after `from`, not inside a quote or a substitution when `quoted` says to look. */
function nextBrace(word: string, from: number, quoted: boolean): number {
  if (!quoted) return word.indexOf('{', from);
  for (let i = from; i < word.length; i += 1) {
    const opaque = opaqueEnd(word, i);
    if (opaque !== -1) i = opaque - 1;
    else if (word.charAt(i) === '\\') i += 1;
    else if (word.charAt(i) === '{') return i;
  }
  return -1;
}

function expand(word: string, room: { left: number }, quoted: boolean): string[] | null {
  for (
    let open = nextBrace(word, 0, quoted);
    open !== -1;
    open = nextBrace(word, open + 1, quoted)
  ) {
    if (open > 0 && word.charAt(open - 1) === '\\') continue;
    // `${x}` is a parameter expansion, not a brace expansion.
    if (open > 0 && word.charAt(open - 1) === '$') continue;
    const close = closing(word, open, quoted);
    if (close === -1) continue;
    const words = alternatives(word.slice(open + 1, close), quoted);
    if (words === null) continue;
    const prefix = word.slice(0, open);
    const suffix = word.slice(close + 1);
    const out: string[] = [];
    for (const alternative of words) {
      const inner = expand(`${prefix}${alternative}${suffix}`, room, quoted);
      if (inner === null) return null;
      for (const made of inner) out.push(made);
    }
    return out;
  }
  room.left -= 1;
  return room.left < 0 ? null : [word];
}

/** The longest word that is read for braces: past it, the word is not read at all. */
const MAX_BRACE_CHARS = 512;

/**
 * The words a word with a brace expansion is, or null when it is too long or makes more than
 * `MAX_BRACE_WORDS` and is not read further. A word without one is itself.
 */
export function expandBraces(word: string): string[] | null {
  return word.length > MAX_BRACE_CHARS ? null : expand(word, { left: MAX_BRACE_WORDS }, false);
}

/**
 * The same for a word as it is written, quotes and all, which the shell expands before it takes the
 * quotes off: `{bash,-c,'rm -rf ~'}` is `bash`, `-c` and `'rm -rf ~'`. A brace, a comma or a
 * parenthesis inside a quote, backticks, `$'…'` or `$(…)` is text.
 */
export function expandWrittenBraces(word: string): string[] | null {
  return word.length > MAX_BRACE_CHARS ? null : expand(word, { left: MAX_BRACE_WORDS }, true);
}
