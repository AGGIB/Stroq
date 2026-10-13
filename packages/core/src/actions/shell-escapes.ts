/**
 * What a shell makes of the text of a word before it is a word: the escapes `echo`, `printf` and
 * `$'…'` decode, the expansions it rewrites, the body of a here-document, and the paths that name
 * its own standard input. Each is a question of what a command is given, as against what the text
 * says, and each answer is the more careful one where shells differ.
 */

import { matchesPattern } from './file-glob.js';

/** What a path that may be a standard input is: the shell's own, another descriptor, or unknown. */
export type StdinPath = 'stdin' | 'descriptor' | 'unknown' | null;

/**
 * Whether a path names this process's standard input: `/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`
 * however it is spelt (`/dev//stdin`, `/dev/./stdin`, `/dev/fd/00`, `/dev/fd/../fd/0`,
 * `/dev/../dev/stdin`, `/dev/stdin/`). Another descriptor (`/dev/fd/3`, `/proc/1234/fd/0`), or a
 * path under `/dev` or `/proc` that expands (`/dev/std?n`, `/dev/fd/*`), is a program from a source
 * this cannot name. A path that is neither is null.
 */
export function stdinPath(path: string): StdinPath {
  // Spelt from the root, or by climbing out of wherever the command is: `//dev/stdin`,
  // `/./dev/stdin`, `/../dev/stdin`, `../../../dev/stdin`.
  if (!path.startsWith('/') && !path.startsWith('..')) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const normal = `/${parts.join('/')}`;
  if (!normal.startsWith('/dev/') && !normal.startsWith('/proc/')) {
    // A pattern in the first name that could be `dev` or `proc` (`/de?/stdin`) is not read.
    const first = parts[0] ?? '';
    return /[*?[]/.test(first) && (matchesPattern(first, 'dev') || matchesPattern(first, 'proc'))
      ? 'unknown'
      : null;
  }
  if (/[$*?[`~]/.test(path)) return 'unknown';
  if (normal === '/dev/stdin' || /^\/dev\/fd\/0+$/.test(normal)) return 'stdin';
  if (/^\/proc\/(?:self|thread-self)\/fd\/0+$/.test(normal)) return 'stdin';
  if (/\/fd\/\d+$/.test(normal) || /\/dev\/(?:stdin|stdout|stderr)$/.test(normal))
    return 'descriptor';
  return /^\/proc\/[^/]*\/fd\//.test(normal) ? 'unknown' : null;
}

// -------------------------------------------------------------------------------------------
// Escapes and expansions
// -------------------------------------------------------------------------------------------

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\u0007',
  b: '\b',
  f: '\f',
  v: '\v',
  e: '\u001b',
  E: '\u001b',
  '\\': '\\',
};
/** What `printf` and `$'…'` also take: `\'` and `\"`. `echo` prints the backslash as it is. */
const QUOTE_ESCAPES: Readonly<Record<string, string>> = { "'": "'", '"': '"' };

/**
 * Whose reading of a backslash escape: `echo -e` and `printf %b` (octal needs a leading 0), the
 * format of `printf` (octal is one to three digits) and `$'…'` (the same, and `\cX`, `\?`).
 * Where shells differ the reading is the wider one: a program is decoded if any of them runs it.
 */
export type EscapeMode = 'echo' | 'printf' | 'ansi';

/** The digits an escape takes after its letter: `\x41`, `r`, `\U00000072`. */
const HEX_DIGITS: Readonly<Record<string, RegExp>> = {
  x: /^[0-9a-fA-F]{1,2}/,
  u: /^[0-9a-fA-F]{1,4}/,
  U: /^[0-9a-fA-F]{1,8}/,
};
/** The longest escape: `\U` and eight digits. */
const LONGEST_ESCAPE = 10;

/** How many characters the escape that starts with the backslash at `at` takes: `\x72`, `\040`, `\n`. */
export function escapeLength(text: string, at: number, mode: EscapeMode): number {
  const next = text.charAt(at + 1);
  const hex = HEX_DIGITS[next];
  if (hex !== undefined) {
    const digits = hex.exec(text.slice(at + 2, at + LONGEST_ESCAPE))?.[0];
    return digits === undefined ? 2 : 2 + digits.length;
  }
  if (/[0-7]/.test(next)) {
    const octal = mode === 'echo' ? /^0[0-7]{0,3}/ : /^[0-7]{1,3}/;
    const digits = octal.exec(text.slice(at + 1, at + 5))?.[0];
    return digits === undefined ? 2 : 1 + digits.length;
  }
  if (next === 'c' && mode === 'ansi' && at + 2 < text.length) return 3;
  return Math.min(2, text.length - at);
}

/**
 * Whether the text has an octal escape with no leading 0 (`\155`): `echo` and `printf %b` read it
 * in dash and bash's `printf` and leave it in bash's and zsh's `echo`, so what it prints is not known.
 */
export function hasAmbiguousOctal(text: string): boolean {
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (text.charAt(i) !== '\\') continue;
    if (/[1-7]/.test(text.charAt(i + 1))) return true;
    i += 1;
  }
  return false;
}

const LAST_CODE_POINT = 0x10ffff;

/** The character a backslash escape stands for, or the escape as written when it is not one. */
export function decodeOne(text: string, at: number, length: number, mode: EscapeMode): string {
  const next = text.charAt(at + 1);
  const written = text.slice(at, at + length);
  if (next in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[next] as string;
  if (mode !== 'echo' && next in QUOTE_ESCAPES) return QUOTE_ESCAPES[next] as string;
  if (next === '?' && mode === 'ansi') return '?';
  if (next === 'c' && length === 3) return String.fromCharCode(text.charCodeAt(at + 2) & 0x1f);
  if (HEX_DIGITS[next] !== undefined && length > 2) {
    const code = Number.parseInt(text.slice(at + 2, at + length), 16);
    if (next === 'x') return String.fromCharCode(code);
    return code <= LAST_CODE_POINT ? String.fromCodePoint(code) : written;
  }
  // `echo` takes octal only with a leading 0 (`\0101`); without one the backslash stays.
  if (/[0-7]/.test(next) && length > 1 && (mode !== 'echo' || next === '0'))
    return String.fromCharCode(Number.parseInt(text.slice(at + 1, at + length), 8) & 0xff);
  return written;
}

/**
 * An escape sequence of `echo -e`, `printf` and `$'…'`, decoded; one this does not know stays as
 * written. A NUL is dropped: a shell given a program that has one does not run what follows it
 * as the text says, and reading the whole of it is the more careful reading.
 */
export function decodeEscapes(text: string, mode: EscapeMode): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== '\\' || i + 1 >= text.length) {
      parts.push(ch);
      continue;
    }
    const length = escapeLength(text, i, mode);
    parts.push(decodeOne(text, i, length, mode));
    i += length - 1;
  }
  return parts.join('').replaceAll('\0', '');
}

/** What may follow a `$` to make it an expansion: a name, a brace, a parenthesis, a parameter. */
const EXPANSION_START = /[A-Za-z_{([@*#?!$0-9~=-]/;

/**
 * Whether the text has an expansion the shell performs before the command sees it, so that what
 * it prints is not what it says: `$name`, `${…}`, `$(…)`, `$((…))`, backticks, a glob, and a
 * brace expansion (`{rm,-rf,~}`), outside single quotes; and in zsh the word that begins with
 * `=` (`=bash` is the path of `bash`, `=(cmd)` a file of its output). What such an argument is
 * cannot be known from the command line.
 */
export function hasExpansion(text: string): boolean {
  let quote = '';
  // Where the next `}` is: -2 before it was looked for, and Infinity when there is none, so that
  // a text of `{` with no `}` is not searched again from each of them.
  let closeBrace = -2;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') i += 1;
    else if (ch === '$' && quote === '' && text.charAt(i + 1) === "'") i = endOfAnsiC(text, i + 1);
    else if (ch === "'" && quote === '') quote = "'";
    else if (ch === '"') quote = quote === '"' ? '' : '"';
    else if (ch === '`') return true;
    else if (ch === '$' && EXPANSION_START.test(text.charAt(i + 1))) return true;
    else if (quote === '' && (ch === '*' || ch === '?' || ch === '[')) return true;
    else if (quote === '' && ch === '{') {
      // A brace expansion needs a `,` or `..` between the braces.
      if (closeBrace < i) {
        const found = text.indexOf('}', i + 1);
        closeBrace = found === -1 ? Number.POSITIVE_INFINITY : found;
      }
      const inner = closeBrace === Number.POSITIVE_INFINITY ? '' : text.slice(i + 1, closeBrace);
      if (inner.includes(',') || inner.includes('..')) return true;
    }
  }
  return /^=[A-Za-z_(]/.test(text);
}

/** The index of the quote that closes a `$'…'` string whose opening quote is at `from`. */
function endOfAnsiC(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i += 1) {
    if (text.charAt(i) === '\\') i += 1;
    else if (text.charAt(i) === "'") return i;
  }
  return text.length;
}

/**
 * Whether the body of a here-document is expanded: its delimiter was not quoted, and it holds a
 * `$`, a backtick, or a backslash that takes a character with it. Quotes are not special in it.
 */
export function heredocExpands(body: string): boolean {
  return /[$`]|\\[$`\\\n]/.test(body);
}

/**
 * The body of a here-document whose delimiter was not quoted, as the shell hands it on once it
 * has taken the backslashes it reads: `\$`, a backtick and `\\` lose theirs, and a backslash and a
 * line break are joined. What expands (`$x`, `$(…)`) stays as written, for the reading that follows.
 */
export function expandHeredoc(body: string): string {
  return body.replace(/\\([$`\\])|\\\n/g, (_whole, kept: string | undefined) => kept ?? '');
}
