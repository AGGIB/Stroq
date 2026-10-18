import { TRAILING, normalizePackageName, trimEndOf } from './package-name.js';

/**
 * Reading the words after a runner or an installer as the shell reads them. A word is what the
 * shell makes of it before the package manager sees it: a backslash takes itself out in front of the
 * next character, quotes come off and the pieces they hold are joined (`ev"il"-pkg` is `evil-pkg`),
 * and a variable or a command in the word makes it a name nobody can read from the command.
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
const PACKAGE_FLAGS = new Set(['-p', '--package']);
const PACKAGE_FLAG_WITH_VALUE = '--package=';
const QUOTE_CHAR = /["']/;
const EXPANSION = /[$`]/;
/** What a double quote lets a backslash escape. */
const ESCAPED_IN_DOUBLE_QUOTES = '$`"\\';

/** A word with its quotes and backslashes taken out, and whether a quote in it was never closed. */
export interface ShellWord {
  readonly word: string;
  readonly open: boolean;
}

/** What a double quote at `at` holds, and where it closes (-1 if it never does). */
function doubleQuoted(token: string, at: number): { piece: string; end: number } {
  let piece = '';
  for (let i = at + 1; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (
      char === '\\' &&
      i + 1 < token.length &&
      ESCAPED_IN_DOUBLE_QUOTES.includes(token.charAt(i + 1))
    ) {
      piece += token.charAt(i + 1);
      i += 1;
    } else if (char === '"') {
      return { piece, end: i };
    } else {
      piece += char;
    }
  }
  return { piece, end: -1 };
}

/**
 * `token` as the shell reads a word. Outside quotes a backslash takes itself out in front of the
 * character after it (`e\vil` is `evil`) and stays at the end of a word, where it is the mark of
 * a continuation. Single quotes keep what they hold; double quotes keep it too, except that a
 * backslash in them escapes only `$`, a backtick, `"` and itself. A quote that is never closed is
 * left in the word, with the rest of the token after it, and the word is `open`.
 */
export function shellWord(token: string): ShellWord {
  let word = '';
  for (let i = 0; i < token.length; i += 1) {
    const char = token.charAt(i);
    if (char === '\\') {
      word += i + 1 < token.length ? token.charAt(i + 1) : char;
      i += 1;
    } else if (char === "'") {
      const end = token.indexOf("'", i + 1);
      if (end === -1) return { word: word + token.slice(i), open: true };
      word += token.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      const { piece, end } = doubleQuoted(token, i);
      if (end === -1) return { word: word + token.slice(i), open: true };
      word += piece;
      i = end;
    } else {
      word += char;
    }
  }
  return { word, open: false };
}

/** A word that is only the mark of a continuation, and is neither a flag nor a package. */
const isContinuationMark = (word: string): boolean => word === '\\';

/**
 * A word that cannot be read as one name: it holds a variable or a command (`$PKG`, `ev$IL`,
 * `${P}`, a backtick) in the part that is the name (a version after `@` is not the name), or a
 * quote in it was never closed. A quote left at the end of a word is not: it is the one that
 * closes the string a command is written in (a commit message that says "use npx prettier").
 */
function isDoubtful(read: ShellWord): boolean {
  if (EXPANSION.test(normalizePackageName(read.word))) return true;
  return read.open && QUOTE_CHAR.test(trimEndOf(read.word, TRAILING));
}

/** A word that can be a package: not a flag, a path, a URL, and not one that is doubtful. */
function isPackageWord(read: ShellWord): boolean {
  const { word } = read;
  return (
    word !== '' &&
    !word.startsWith('-') &&
    !word.startsWith('\\') &&
    !word.startsWith('.') &&
    !word.startsWith('/') &&
    !word.startsWith('$') &&
    !word.includes('://') &&
    !isDoubtful(read)
  );
}

/** The value a package flag carries: the word after `-p` or `--package`, or what follows `--package=` or `-p`. */
function packageFlagValue(
  flag: string,
  next: string | undefined,
): { raw: string | undefined; skip: boolean } | null {
  if (PACKAGE_FLAGS.has(flag)) return { raw: next, skip: true };
  if (flag.startsWith(PACKAGE_FLAG_WITH_VALUE)) {
    return { raw: flag.slice(PACKAGE_FLAG_WITH_VALUE.length), skip: false };
  }
  if (/^-p[^-]/.test(flag)) return { raw: flag.slice(2), skip: false };
  return null;
}

/** What a runner's words say about its packages. */
export interface RunnerReading {
  /** Every package named by `-p`/`--package`, or else the first word that is not a flag. */
  readonly packages: string[];
  /**
   * The first word that is not a flag was reached, which settles the packages: nothing after it
   * can add one. False when the words ran out first, and a later `-p` may still name another.
   */
  readonly sure: boolean;
  /** A word that should have named a package is a variable, a command or a quote never closed. */
  readonly doubt: boolean;
}

/**
 * The packages a runner (`npx`, `pnpm dlx`, …) resolves: every `-p <pkg>` (also `--package <pkg>`,
 * `--package=<pkg>`, `-p<pkg>`), else the first word that is not a flag. With `-p` the word after
 * the flags is the command that runs, not a package.
 */
export function readRunner(tokens: readonly string[]): RunnerReading {
  const fromFlags: string[] = [];
  let doubt = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const read = shellWord(tokens[i] ?? '');
    if (isContinuationMark(read.word)) continue;
    const flag = packageFlagValue(read.word, tokens[i + 1]);
    if (flag !== null) {
      const value = flag.raw === undefined ? undefined : shellWord(flag.raw);
      if (value !== undefined && isPackageWord(value)) fromFlags.push(value.word);
      else if (value !== undefined && isDoubtful(value)) doubt = true;
      if (flag.skip) i += 1;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(read.word)) {
      i += 1;
      continue;
    }
    if (read.word.startsWith('-')) continue;
    if (fromFlags.length > 0) return { packages: fromFlags, sure: true, doubt };
    if (isPackageWord(read)) return { packages: [read.word], sure: true, doubt };
    return { packages: [], sure: true, doubt: doubt || isDoubtful(read) };
  }
  return { packages: fromFlags, sure: false, doubt };
}

/** Every package an installer's words name, and whether a word that should have named one is a doubt. */
export function readInstaller(tokens: readonly string[]): { packages: string[]; doubt: boolean } {
  const packages: string[] = [];
  let doubt = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const read = shellWord(tokens[i] ?? '');
    if (isContinuationMark(read.word)) continue;
    if (FLAGS_WITH_VALUE.has(read.word)) {
      i += 1;
      continue;
    }
    if (isPackageWord(read)) packages.push(read.word);
    else if (isDoubtful(read)) doubt = true;
  }
  return { packages, doubt };
}
