import { TRAILING, normalizePackageName, trimEndOf } from './package-name.js';
import type { ShellWord } from './shell-word.js';

/**
 * The word in the place of a package, read as a NAME and what comes after it. A package is named
 * by the leading run of the characters a name is made of (a scope, slashes, dots, dashes); the
 * rest is a SUFFIX: a version (`@1.2`, `@$V`, `@$(cmd)`), extras (`[socks]`), a bound (`==1.*`,
 * `>=1,<2`), a fragment (`#egg=x`), and the characters that end a word in a shell (`)`, `&`, `>`,
 * `!`). The suffix says nothing about which package it is, so it never makes the word a doubt; a
 * doubt is a NAME that cannot be read, because a variable, a glob, a brace, a parenthesis, a
 * backtick or a quote stands inside it, or because there is none. Reading the name wherever it
 * stands is what lets a package that was flagged be found in `(npx x)`, `$(npx x)` and `npm i x@$V`.
 *
 * Known limit: a bracket that follows a name directly is read as extras, so a name that is really a
 * glob over a file in the working directory is read as the name before the bracket.
 */

/** The characters of a package's name. A leading `@` is a scope; one after the name starts a version. */
const NAME_CHAR = /[\w./+:@-]/;
/** The first character of a suffix, where it stands right after a name (`[` is read apart). */
const SUFFIX_START = '<>=!,#~)&|; \t';
/** What may follow the brackets of extras and still leave them extras. */
const AFTER_EXTRAS = '<>=!,#~)&|;@ \t';
/** Extras as they are written: the brackets with names between them, right after the package. */
const EXTRAS = /\[[\w.,-]+\]/y;
/** Characters that close the command the word was read in, where they follow the name. */
const COMMAND_CLOSERS = ');|';
/** A redirection operator left at the end of a word, whose target is the word after it. */
const BARE_OPERATOR = /^(?:[0-9]*[<>]{1,2}|&>>?)$/;
/** A word that is a flag, a place or an address, not the name of a package in a registry. */
const NOT_A_NAME_START = '.-/~\\';

/** What the word in the place of a package says. */
export interface PackageWord {
  /** The package it names, lower-cased and without its version; undefined when it names none. */
  readonly name: string | undefined;
  /** A word that should have named a package could not be read: see the note above. */
  readonly doubt: boolean;
  /**
   * The word closes the command it was read in (`)`, `;`, `|`, `&`), so no later word belongs to
   * it. Only a closer that stands unquoted and unescaped does: `"a&b"` and `'a)'` end nothing.
   */
  readonly ends: boolean;
  /** The word ends in a redirection operator whose target is the next word, which is not a package. */
  readonly skipsNext: boolean;
  /**
   * A quote in the word was never closed inside it, and is not the one that closes the string a
   * command is written in. Where the quote closes is unknown, so nothing after it in the line is
   * known to be shell syntax. It is a doubt.
   */
  readonly opensQuote: boolean;
}

const NONE: PackageWord = {
  name: undefined,
  doubt: false,
  ends: false,
  skipsNext: false,
  opensQuote: false,
};

/** Where the name stops: at the first character a name is not made of, or at the `@` of a version. */
function nameEnd(word: string): number {
  let at = 0;
  while (at < word.length && NAME_CHAR.test(word.charAt(at))) {
    if (word.charAt(at) === '@' && at > 0) break;
    at += 1;
  }
  return at;
}

/**
 * Whether what stands after the name is a suffix, and not more of a name that the shell would
 * expand. `[socks]` is extras only when it is written as extras are and nothing that belongs to a
 * name follows the closing bracket (`ev[i]l` is a glob), and a `!` only when nothing but more of
 * them follows (`ev!l` is history expansion in a shell that has it). A `(`, a `{`, a `*` and a `?`
 * touching the name are not a suffix.
 */
function standsAlone(word: string, end: number): boolean {
  const stop = word.charAt(end);
  if (end === word.length || stop === '@') return true;
  if (stop === '!') return /^!+$/.test(word.slice(end));
  if (stop === '[') {
    EXTRAS.lastIndex = end;
    const extras = EXTRAS.exec(word);
    if (extras === null) return false;
    const after = end + extras[0].length;
    return after === word.length || AFTER_EXTRAS.includes(word.charAt(after));
  }
  return SUFFIX_START.includes(stop);
}

/** Whether the character at `at` is a closer of a command: `)`, `;`, `|`, or a `&` that does not start `&>`. */
const isCloser = (word: string, at: number): boolean =>
  at < word.length &&
  (COMMAND_CLOSERS.includes(word.charAt(at)) ||
    (word.charAt(at) === '&' && word.charAt(at + 1) !== '>'));

/**
 * What `read` says about a package. A word that is a flag, a path, a home directory or an address
 * is not a package and not a doubt, and nor is the quote that closes the string a command is
 * written in. A quote left open in front of the name is a doubt (what the shell would make of the
 * word depends on where it closes), but the name after it is still read.
 */
export function readPackageWord(read: ShellWord): PackageWord {
  const lead = read.word.length - read.word.replace(/^["']+/, '').length;
  const unquoted = read.word.slice(lead);
  const word = trimEndOf(unquoted, TRAILING);
  // A character is syntax only where nothing quoted or escaped it.
  const plain = (at: number): boolean => read.literal[lead + at] !== true;
  const trailer = unquoted.slice(word.length);
  const closesAfterWord = [...trailer].some((char, k) => char === ')' && plain(word.length + k));
  if (word === '') return { ...NONE, ends: closesAfterWord };
  if (NOT_A_NAME_START.includes(word.charAt(0)) || word.includes('://')) return NONE;

  const end = nameEnd(word);
  const readable = standsAlone(word, end);
  const name = readable ? normalizePackageName(word.slice(0, end)) : '';
  const opensQuote = read.open && (lead > 0 || /["']/.test(word));
  return {
    name: name === '' ? undefined : name,
    doubt: opensQuote || !readable || trailer.includes('?') || (name === '' && end > 0),
    ends: (isCloser(word, end) && plain(end)) || closesAfterWord,
    skipsNext: BARE_OPERATOR.test(word.slice(end)) && plain(end),
    opensQuote,
  };
}
