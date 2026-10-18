import { TRAILING, normalizePackageName, trimEndOf } from './package-name.js';

/**
 * Reading the words after a runner or an installer as the shell reads them, under one rule. A word
 * in the place of a package is READ when, once the shell has unquoted it, it is made of the
 * characters of a package name and none of the characters in it was one the shell would expand
 * (a variable, a command, a brace, a glob, a redirection). Any other word is a DOUBT: what it
 * stands for cannot be read from the command, and the caller counts the command as unread. It is
 * never a package that was quietly not there.
 */

const FLAGS_WITH_VALUE = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-t',
  '--target',
  '--registry',
  '--prefix',
]);

/** The flags that name a package, by the kind of runner. A flag may carry its value as `--flag=value`. */
const PACKAGE_FLAGS: Readonly<Record<RunnerFamily, ReadonlySet<string>>> = {
  node: new Set(['-p', '--package']),
  python: new Set(['--from', '--with', '--spec']),
};
/** Flags of a Python runner that take a value that is not a package. */
const PYTHON_VALUE_FLAGS = new Set([
  '-p',
  '--python',
  '--with-requirements',
  '--with-editable',
  '--index',
  '--index-url',
  '--extra-index-url',
]);

export type RunnerFamily = 'node' | 'python';

/** `npx`, `pnpm dlx`, `yarn dlx`, `bunx` and `npm exec` read `-p`; `uvx`, `pipx run` and `uv tool run` read `--from` and `--with`. */
export const runnerFamily = (match: string): RunnerFamily =>
  /^(?:uvx|pipx|uv)\b/i.test(match) ? 'python' : 'node';

/** The characters a package name is made of, once its version and extras are cut off. */
const NAME_CHARS = /^[A-Za-z0-9@/._:+~=,-]*$/;
/** Characters the shell expands or acts on where they are not quoted. */
const EXPANDING = '(){}*?[]!<>|;&';
/** A PEP 508 extras suffix (`requests[socks]`), which is part of a name and not a glob. */
const EXTRAS = /\[[A-Za-z0-9._,-]*\](?=$|[<>=!~;@"'])/g;
const QUOTE_CHAR = /["']/;
/** A redirection (`>`, `2>&1`, `&>`), which is neither a flag nor a package. */
const REDIRECTION = /^(?:[0-9]*[<>]|&>)/;
const ONLY_AN_OPERATOR = /^(?:[0-9]*[<>]{1,2}|&>>?)$/;

/** A word with its quotes and backslashes taken out, and what in it was not plain text. */
export interface ShellWord {
  readonly word: string;
  /** A quote in it was never closed. */
  readonly open: boolean;
  /** A character the shell would expand stood in it, unquoted (see `EXPANDING`), in the part that is the name. */
  readonly meta: boolean;
}

/** Where in `token` the version of a name starts: its first `@` that is not the one of a scope. */
const versionStart = (token: string): number => {
  const at = token.indexOf('@', 1);
  return at === -1 ? token.length : at;
};

/** The index ranges of `token` that are an extras suffix. */
const extrasSpans = (token: string): [number, number][] =>
  [...token.matchAll(EXTRAS)].map((m): [number, number] => [
    m.index ?? 0,
    (m.index ?? 0) + m[0].length,
  ]);

/** The index of the first character after the quote that opens at `at`, with what it holds and the indexes of what it expands. */
function quoted(token: string, at: number): { piece: string; end: number; expansions: number[] } {
  const quote = token.charAt(at);
  let piece = '';
  const expansions: number[] = [];
  for (let i = at + 1; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char === quote) return { piece, end: i, expansions };
    if (
      quote === '"' &&
      char === '\\' &&
      i + 1 < token.length &&
      '$`"\\'.includes(token.charAt(i + 1))
    ) {
      piece += token.charAt(i + 1);
      i += 1;
      continue;
    }
    if (quote === '"' && (char === '$' || char === '`')) expansions.push(i);
    piece += char;
  }
  return { piece, end: -1, expansions };
}

/**
 * `token` as the shell reads a word. Outside quotes a backslash takes itself out in front of the
 * character after it (`e\vil` is `evil`) and stays at the end of a word, where it is the mark of
 * a continuation. Single quotes keep what they hold; double quotes keep it too, except that a
 * backslash in them escapes only `$`, a backtick, `"` and itself, and that `$` and a backtick in
 * them still expand. A quote that is never closed is left in the word, with the rest of the token
 * after it, and the word is `open`.
 *
 * `meta` is whether a character that expands stood in the name: before its version, outside an
 * extras suffix, and not in the run of prose punctuation that ends a word.
 */
export function shellWord(token: string): ShellWord {
  let word = '';
  const expanding: number[] = [];
  let open = false;
  for (let i = 0; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char === '\\') {
      word += i + 1 < token.length ? token.charAt(i + 1) : char;
      i += 1;
    } else if (char === "'" || char === '"') {
      const { piece, end, expansions } = quoted(token, i);
      expanding.push(...expansions);
      if (end === -1) {
        word += token.slice(i);
        open = true;
        break;
      }
      word += piece;
      i = end;
    } else {
      if (char === '$' || char === '`' || EXPANDING.includes(char) || (char === '~' && i === 0))
        expanding.push(i);
      word += char;
    }
  }
  const nameEnd = Math.min(versionStart(token), trimEndOf(token, TRAILING).length);
  const spans = extrasSpans(token);
  const meta = expanding.some(
    (index) => index < nameEnd && !spans.some(([from, to]) => index >= from && index < to),
  );
  return { word, open, meta };
}

/** A word that is only the mark of a continuation, and is neither a flag nor a package. */
const isContinuationMark = (word: string): boolean => word === '\\';

/**
 * A word that cannot be read as one name: it expands (`meta`), a quote in it was never closed
 * (a quote left at the end of a word is not that: it closes the string a command is written in),
 * or what is left of its name once its version is cut off holds a character no package name has.
 */
function isDoubtful(read: ShellWord): boolean {
  if (read.meta) return true;
  if (read.open && QUOTE_CHAR.test(trimEndOf(read.word, TRAILING))) return true;
  return !NAME_CHARS.test(normalizePackageName(read.word));
}

/**
 * A word that is a package: not a flag, a path, a URL, and, in a command, not one that is
 * doubtful. In a page the words are read for the name in them and nothing else: a page that says
 * `pip install requests>=2` names `requests`, though a shell would not run it that way.
 */
function isPackageWord(read: ShellWord, command: boolean): boolean {
  const { word } = read;
  return (
    word !== '' &&
    !word.startsWith('-') &&
    !word.startsWith('\\') &&
    !word.startsWith('.') &&
    !word.startsWith('/') &&
    !word.startsWith('$') &&
    !word.includes('://') &&
    (!command || !isDoubtful(read))
  );
}

/** The value a package flag carries: the word after it, or what follows `=` or the short flag. */
function packageFlagValue(
  flag: string,
  next: string | undefined,
  flags: ReadonlySet<string>,
): { raw: string | undefined; skip: boolean } | null {
  if (flags.has(flag)) return { raw: next, skip: true };
  const equals = flag.indexOf('=');
  if (equals > 0 && flags.has(flag.slice(0, equals)))
    return { raw: flag.slice(equals + 1), skip: false };
  if (/^-[a-z][^-]/.test(flag) && flags.has(flag.slice(0, 2))) {
    const value = flag.slice(2);
    return { raw: value.startsWith('=') ? value.slice(1) : value, skip: false };
  }
  return null;
}

/** What a runner's words say about its packages. */
export interface RunnerReading {
  /** The value of every package flag, and the first word that is not a flag. */
  readonly packages: string[];
  /**
   * The first word that is not a flag was reached, which settles the packages: nothing after it
   * can add one. False when the words ran out first, and a later package flag may still name one.
   */
  readonly sure: boolean;
  /** A word that should have named a package is a doubt (see `isDoubtful`). */
  readonly doubt: boolean;
}

/** Whether the word is the end of the command (`&`) or a redirection to step over, and how many words it takes. */
function stepOver(token: string): number {
  if (token === '&') return -1;
  if (!REDIRECTION.test(token)) return 0;
  return ONLY_AN_OPERATOR.test(token) ? 2 : 1;
}

/**
 * The packages a runner resolves: the value of every package flag of its kind (see
 * `PACKAGE_FLAGS`; `-p`, `--package`, `--package=x`, `-p=x`, `-px` for `npx`; `--from`, `--with`
 * for `uvx`), and the first word that is not a flag, whether or not a flag named one. A package
 * flag with no value, or with a value that cannot be read, is a doubt.
 */
export function readRunner(
  tokens: readonly string[],
  family: RunnerFamily,
  command: boolean,
): RunnerReading {
  const fromFlags: string[] = [];
  const packageFlags = PACKAGE_FLAGS[family];
  let doubt = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const step = stepOver(token);
    if (step === -1) break;
    if (step > 0) {
      i += step - 1;
      continue;
    }
    const read = shellWord(token);
    if (isContinuationMark(read.word)) continue;
    const flag = packageFlagValue(read.word, tokens[i + 1], packageFlags);
    if (flag !== null) {
      const value = flag.raw === undefined ? undefined : shellWord(flag.raw);
      if (value !== undefined && isPackageWord(value, command)) fromFlags.push(value.word);
      else if (value !== undefined)
        doubt = doubt || (command && (value.word === '' || isDoubtful(value)));
      if (flag.skip) i += 1;
      continue;
    }
    if (
      FLAGS_WITH_VALUE.has(read.word) ||
      (family === 'python' && PYTHON_VALUE_FLAGS.has(read.word))
    ) {
      i += 1;
      continue;
    }
    if (read.word.startsWith('-')) continue;
    if (isPackageWord(read, command))
      return { packages: [...fromFlags, read.word], sure: true, doubt };
    return { packages: fromFlags, sure: true, doubt: doubt || (command && isDoubtful(read)) };
  }
  return { packages: fromFlags, sure: false, doubt };
}

/** Every package an installer's words name, and whether a word that should have named one is a doubt. */
export function readInstaller(
  tokens: readonly string[],
  command: boolean,
): { packages: string[]; doubt: boolean } {
  const packages: string[] = [];
  let doubt = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    const step = stepOver(token);
    if (step === -1) break;
    if (step > 0) {
      i += step - 1;
      continue;
    }
    const read = shellWord(token);
    if (isContinuationMark(read.word)) continue;
    if (FLAGS_WITH_VALUE.has(read.word)) {
      i += 1;
      continue;
    }
    if (isPackageWord(read, command)) packages.push(read.word);
    else if (command && !read.word.startsWith('-') && isDoubtful(read)) doubt = true;
  }
  return { packages, doubt };
}
