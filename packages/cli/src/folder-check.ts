// The check of a folder, when an agent in a session is about to run what is in it.
//
// `stroq inspect` reads a folder for a person who thought to ask. This is the same reading for the
// one who did not: the first time an agent in a session runs git or a command that runs the project's
// code, the folder is read, and what honest projects rarely do becomes a question. It is a reading of
// text, so it says nothing of what it did not see. It cannot get in front of what an agent runs at its
// own startup, which is why `inspect` stays.
//
// A question is not answered by being shown. It counts as a yes when the host reports that the command
// it was about ran; until then it is asked again, so a "no", a question nobody saw, or a host that can
// only refuse (Codex, Windsurf) does not let the next try through.
//
// The hook is a process of its own for each call, and most calls trigger nothing: only the words of
// the command are looked at until one does, and the readers are loaded then.
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { commandWord, readRegularFile, splitSegments } from '@stroq/core';
import { readTrustedFolders } from './folder-trust.js';
import { trustedFoldersFileIn } from './paths.js';

export interface FolderCheckInput {
  readonly sessionId: string;
  readonly command: string;
  readonly cwd: string;
  /** The host's id for this call, when it gives one: a report of another call answers nothing. */
  readonly callId?: string;
}

export interface FolderCheckOptions {
  /** Where Stroq keeps its state: the markers go in a folder under it. */
  readonly home: string;
  /** The home of the person. It is never read as a project. */
  readonly userHome: string;
  readonly budgetMs?: number;
}

export interface FolderQuestion {
  readonly ruleId: 'ask-foreign-folder';
  readonly reason: string;
}

/** Long enough to read an ordinary project, short of what a host waits for. */
const BUDGET_MS = 1500;
const MARKERS = 'folder-checks';
const MARKER_MAX = 256 * 1024;
const GIT_FILE_MAX = 4096;
/** The most folders walked up to find the top of a repository: a path has an end, and this is past it. */
const MAX_UP = 4096;
/** How much of a command is looked at. It is read again here, on every call that is allowed. */
const MAX_COMMAND_TEXT = 256 * 1024;
const MAX_SEGMENTS = 1000;
const MAX_SEGMENT_TEXT = 8192;
const MAX_WORDS_LOOKED_AT = 16;
/** A marker is about one session: past this many of them, the ones this old go. */
const MARKERS_KEPT = 2000;
const MARKER_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The programs that run a project's code, or git, which runs its hooks. */
const RUNS_PROJECT: ReadonlySet<string> = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'pnpx',
  'bunx',
  'node',
  'deno',
  'python',
  'python3',
  'pytest',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'tox',
  'make',
  'just',
  'forge',
  'hardhat',
  'truffle',
  'cargo',
  'go',
  'sh',
  'bash',
  'zsh',
  'dash',
  'gradle',
  'gradlew',
  'mvn',
  'mvnw',
  'docker',
  'docker-compose',
  'ruby',
  'rake',
  'bundle',
  'perl',
  'php',
  'composer',
  'vitest',
  'jest',
  'mocha',
  'tsx',
  'ts-node',
  'source',
  '.',
]);

/** The files that say a folder with no git is a project. */
const PROJECT_FILES: readonly string[] = [
  'package.json',
  'Makefile',
  'makefile',
  'GNUmakefile',
  'Justfile',
  'justfile',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'conftest.py',
  'tox.ini',
  'foundry.toml',
  'hardhat.config.js',
  'hardhat.config.ts',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
];

/** The option that says where a program works, for those that have one. */
const FOLDER_OPTION: Readonly<Record<string, readonly string[]>> = {
  git: ['-C'],
  make: ['-C', '--directory'],
  pnpm: ['-C', '--dir'],
  npm: ['--prefix'],
  yarn: ['--cwd'],
};

/** What a shell would have to work out. A backslash is a separator on Windows and an escape elsewhere. */
const NOT_WRITTEN_OUT =
  process.platform === 'win32' ? /[$`*?<>(){}|;&]|^-/ : /[$`*?<>(){}\\|;&]|^-/;

/** The path a word writes out, or null when the shell would have to work it out. */
function writtenPath(word: string | undefined, userHome: string): string | null {
  if (word === undefined || word === '') return null;
  const inner = /^(["'])(.*)\1$/.exec(word)?.[2] ?? word;
  if (inner === '~') return userHome;
  if (inner.startsWith('~/')) return join(userHome, inner.slice(2));
  return inner.includes('~') || NOT_WRITTEN_OUT.test(inner) ? null : inner;
}

/** A word without the brackets of a group or a subshell. A loop: a pattern here would be quadratic. */
function withoutBrackets(word: string): string {
  let from = 0;
  let to = word.length;
  while (from < to && (word[from] === '(' || word[from] === '{')) from += 1;
  while (to > from && (word[to - 1] === ')' || word[to - 1] === '}')) to -= 1;
  return word.slice(from, to);
}

/** The words of a segment as written, a quoted run as one. A segment is looked at only so far. */
const rawWordsOf = (segment: string): string[] =>
  segment.slice(0, MAX_SEGMENT_TEXT).match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

const nameOf = (word: string): string =>
  word
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/, '')
    .replace(/^python[\d.]+$/, 'python');

/** A program named by a path inside the project: `./setup.sh`, `scripts/run`, `node_modules/.bin/jest`. */
const isProjectPath = (word: string): boolean =>
  /[\\/]/.test(word) && !word.startsWith('/') && !/^[A-Za-z]:/.test(word) && !word.startsWith('~');

const ASKS_ABOUT_ITSELF: ReadonlySet<string> = new Set(['--version', '-v', '-V', '--help', '-h']);

interface CommandTarget {
  /** Where the command runs the project's code. */
  readonly folder: string;
  /** What comes after the program's name. */
  readonly words: readonly string[];
  /** Whether the program itself is named by a path in the folder. */
  readonly programInFolder: boolean;
}

/** The first thing a command runs of a project, and where. */
function targetOf(command: string, cwd: string, userHome: string): CommandTarget | null {
  if (command.length > MAX_COMMAND_TEXT) return null;
  let here = cwd;
  const outer: string[] = [];
  for (const segment of splitSegments(command).slice(0, MAX_SEGMENTS)) {
    const name = nameOf(commandWord(segment));
    const raw = rawWordsOf(segment);
    // A `cd` inside a subshell lasts as long as the subshell.
    const opens = raw[0]?.startsWith('(') === true;
    const closes = raw[raw.length - 1]?.endsWith(')') === true;
    if (opens) outer.push(here);
    const words = raw.map(withoutBrackets).filter((word) => word !== '');
    const at = words.findIndex((word) => nameOf(basename(word)) === name);
    const after = words.slice(at + 1);
    if (name === 'cd' || name === 'pushd') {
      const path = writtenPath(
        after.find((word) => !/^-[A-Za-z@]*$/.test(word) && word !== '--'),
        userHome,
      );
      if (path !== null) here = resolve(here, path);
    } else if (name !== '' && (RUNS_PROJECT.has(name) || isProjectPath(words[at] ?? ''))) {
      const onlyAsks = after.length > 0 && after.every((word) => ASKS_ABOUT_ITSELF.has(word));
      if (!onlyAsks) {
        return {
          folder: placedBy(name, after, here, userHome),
          words: after,
          programInFolder: isProjectPath(words[at] ?? ''),
        };
      }
    }
    if (closes) here = outer.pop() ?? here;
  }
  return null;
}

/** The folder an option of the program names, or the folder it starts in. */
function placedBy(name: string, after: readonly string[], here: string, userHome: string): string {
  for (const option of FOLDER_OPTION[name] ?? []) {
    const index = after.indexOf(option);
    const joined = after.find((word) => word.startsWith(`${option}=`));
    const word = joined === undefined ? after[index + 1] : joined.slice(option.length + 1);
    const path = index === -1 && joined === undefined ? null : writtenPath(word, userHome);
    if (path !== null) return resolve(here, path);
  }
  return here;
}

/** Where a command runs git or the project's code, or null when it does neither. */
export function folderOfCommand(command: string, cwd: string, userHome = ''): string | null {
  return targetOf(command, cwd, userHome)?.folder ?? null;
}

/** The real path of a folder, so that two names of one folder are one folder. */
const realOf = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

const isThere = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Whether a path is a folder, following a link as git does. */
const isFolder = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Git's own test of a folder that holds a repository. An empty `.git` is nothing to it. */
const isGitFolder = (path: string): boolean =>
  isThere(join(path, 'HEAD')) && isFolder(join(path, 'objects')) && isFolder(join(path, 'refs'));

/** Whether git would take this folder for the top of a repository. */
function isRepositoryTop(folder: string): boolean {
  const git = join(folder, '.git');
  return isGitFolder(git) || firstLineOf(git)?.startsWith('gitdir:') === true;
}

/** What says a folder with no git is a project, and that a program started in it looks to. */
const hasProjectFile = (folder: string): boolean =>
  PROJECT_FILES.some((name) => isThere(join(folder, name))) || isGitFolder(folder);

/** Walks up from a folder, not past the home folder, and gives the first one that passes. */
function firstUp(start: string, home: string, passes: (folder: string) => boolean): string | null {
  let at = start;
  for (let up = 0; up < MAX_UP; up += 1) {
    if (at === home) return null;
    if (passes(at)) return at;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
  return null;
}

/**
 * The top of the project a folder is in: its repository, or in no repository the nearest folder with
 * a project file, which is where npm or make would look. Else the folder itself. The walk stops at the
 * home folder: dotfiles kept in git there do not make every folder below them one project.
 */
export function topOf(folder: string, userHome = ''): string {
  let start = folder;
  // `cd x && npm test` may be reported from inside x, and a folder that is not there has a parent.
  while (!isThere(start) && dirname(start) !== start) start = dirname(start);
  start = realOf(start);
  const home = userHome === '' ? '' : realOf(userHome);
  if (start === home) return start;
  return firstUp(start, home, isRepositoryTop) ?? firstUp(start, home, hasProjectFile) ?? start;
}

const stamp = (path: string): string => {
  try {
    const { mtimeMs, size } = lstatSync(path);
    return `${mtimeMs}:${size}`;
  } catch {
    return '-';
  }
};

/** The first line of a small file, or null. */
function firstLineOf(path: string): string | null {
  try {
    const read = readRegularFile(path, GIT_FILE_MAX, { noFollow: true });
    return read.kind === 'text' ? (read.text.split('\n')[0] ?? '').trim() : null;
  } catch {
    return null;
  }
}

/**
 * Where git keeps a checkout's own files and its shared ones. In a linked worktree or a submodule
 * `.git` is a file that says where they are, and the hooks and config are in the shared folder.
 */
function gitFoldersOf(top: string): { own: string; shared: string } {
  const plain = join(top, '.git');
  const pointer = firstLineOf(plain);
  if (pointer === null || !pointer.startsWith('gitdir:')) return { own: plain, shared: plain };
  const own = resolve(top, pointer.slice('gitdir:'.length).trim());
  const common = firstLineOf(join(own, 'commondir'));
  return { own, shared: common === null ? own : resolve(own, common) };
}

/** What changes when a folder is updated, cheap enough for every call that triggers. */
function signatureOf(top: string): string {
  const { own, shared } = gitFoldersOf(top);
  return [
    join(shared, 'config'),
    join(shared, 'hooks'),
    join(own, 'HEAD'),
    join(own, 'FETCH_HEAD'),
    join(own, 'ORIG_HEAD'),
    join(top, 'package.json'),
    join(top, 'Makefile'),
  ]
    .map(stamp)
    .join('|');
}

interface Marker {
  /** The folder as it was when it was last read. */
  readonly signature: string;
  /** The places answered in this session. */
  readonly known: readonly string[];
  /** The places a question is out about, and the command it was asked before. */
  readonly pending: readonly string[];
  readonly command: string;
  readonly reason: string;
}

const isIdList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string');

function readMarker(path: string): Marker | null {
  try {
    const read = readRegularFile(path, MARKER_MAX, { noFollow: true });
    if (read.kind !== 'text') return null;
    const value: unknown = JSON.parse(read.text);
    if (typeof value !== 'object' || value === null) return null;
    const { signature, known, pending, command, reason } = value as Record<string, unknown>;
    return typeof signature === 'string' &&
      isIdList(known) &&
      isIdList(pending) &&
      typeof command === 'string' &&
      typeof reason === 'string'
      ? { signature, known, pending, command, reason }
      : null;
  } catch {
    return null;
  }
}

/** Takes away markers past their use, only when there are many: one file per session and folder. */
function prune(folder: string, now: number): void {
  const names = readdirSync(folder);
  if (names.length <= MARKERS_KEPT) return;
  for (const name of names) {
    const path = join(folder, name);
    if (now - lstatSync(path).mtimeMs > MARKER_AGE_MS) rmSync(path, { force: true });
  }
}

function writeMarker(path: string, marker: Marker): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
    renameSync(temporary, path);
    prune(dirname(path), Date.now());
  } catch {
    // Not being able to remember costs a second question, and never a question not asked.
  }
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

const markerPathOf = (home: string, sessionId: string, top: string): string =>
  join(home, MARKERS, `${hashOf(`${sessionId}\0${top}`).slice(0, 32)}.json`);

/** Fixed words and a count: names in the folder are the folder author's text, and a model reads this. */
function questionOf(count: number): string {
  const what =
    count === 1
      ? '1 place that runs by itself, runs what it fetches, or hides what it does'
      : `${count} places that run by themselves, run what they fetch, or hide what they do`;
  return `Stroq read this folder and found ${what}. It may be fine. Read it first: stroq inspect. If you have and it is fine, run this yourself in a terminal: stroq trust --folder .`;
}

/**
 * The folder to look at for a command, or null. A parent folder of projects is not a project: it is
 * read only when the command runs something that is in it.
 */
function folderToRead(input: FolderCheckInput, userHome: string): string | null {
  const target = targetOf(input.command, input.cwd, userHome);
  if (target === null) return null;
  const top = topOf(target.folder, userHome);
  if (top === realOf(userHome) || top === parse(top).root) return null;
  if (isRepositoryTop(top) || hasProjectFile(top) || target.programInFolder) return top;
  const named = target.words
    .slice(0, MAX_WORDS_LOOKED_AT)
    .some((word) => !word.startsWith('-') && existsSync(resolve(target.folder, word)));
  return named ? top : null;
}

const callOf = (input: FolderCheckInput): string =>
  hashOf(`${input.command}\0${input.callId ?? ''}`);

const trustedIn = (home: string, top: string): readonly string[] =>
  readTrustedFolders(trustedFoldersFileIn(home))[top] ?? [];

/** The question to ask before this command runs, or null. Reads; runs nothing. */
export async function checkFolder(
  input: FolderCheckInput,
  options: FolderCheckOptions,
): Promise<FolderQuestion | null> {
  const top = folderToRead(input, options.userHome);
  if (top === null) return null;
  const markerPath = markerPathOf(options.home, input.sessionId, top);
  const marker = readMarker(markerPath);
  const signature = signatureOf(top);
  const command = callOf(input);

  if (marker?.signature === signature) {
    if (marker.pending.length === 0) return null;
    // The person may have read it and said so while the question was out.
    const trusted = new Set(trustedIn(options.home, top));
    const pending = marker.pending.filter((id) => !trusted.has(id));
    const reason = pending.length === 0 ? '' : questionOf(pending.length);
    writeMarker(markerPath, { ...marker, pending, command, reason });
    return pending.length === 0 ? null : { ruleId: 'ask-foreign-folder', reason };
  }

  // Only the first command of a session in a folder pays for loading the readers.
  const { readFolder } = await import('./folder-reading.js');
  const { ids } = readFolder(top, options.budgetMs ?? BUDGET_MS);
  const known = marker?.known ?? [];
  const answered = new Set([...known, ...trustedIn(options.home, top)]);
  const pending = ids.filter((id) => !answered.has(id));
  const reason = pending.length === 0 ? '' : questionOf(pending.length);
  writeMarker(markerPath, { signature, known, pending, command, reason });
  return pending.length === 0 ? null : { ruleId: 'ask-foreign-folder', reason };
}

/** The host reports that a command ran: a question out about that command was answered yes. */
export function noteFolderRan(input: FolderCheckInput, options: FolderCheckOptions): void {
  const top = folderToRead(input, options.userHome);
  if (top === null) return;
  const markerPath = markerPathOf(options.home, input.sessionId, top);
  const marker = readMarker(markerPath);
  if (marker === null || marker.pending.length === 0) return;
  if (marker.command !== callOf(input)) return;
  writeMarker(markerPath, {
    ...marker,
    known: [...new Set([...marker.known, ...marker.pending])],
    pending: [],
    reason: '',
  });
}
