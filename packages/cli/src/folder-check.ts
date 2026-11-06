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
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
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
/** The most folders walked up to find the top of a repository. */
const MAX_UP = 32;
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
]);

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

/** The words of a segment, a quoted run as one, without the brackets of a group or a subshell. */
const wordsOf = (segment: string): string[] =>
  (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((word) => word.replace(/^[({]+/, '').replace(/[)}]+$/, ''))
    .filter((word) => word !== '');

const nameOf = (word: string): string =>
  word
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/, '')
    .replace(/^python[\d.]+$/, 'python');

/** A program named by a path inside the project: `./setup.sh`, `scripts/run`, `node_modules/.bin/jest`. */
const isProjectPath = (word: string): boolean =>
  /[\\/]/.test(word) && !word.startsWith('/') && !/^[A-Za-z]:/.test(word) && !word.startsWith('~');

/** Where a command runs git or the project's code, or null when it does neither. */
export function folderOfCommand(command: string, cwd: string, userHome = ''): string | null {
  let here = cwd;
  for (const segment of splitSegments(command)) {
    const name = nameOf(commandWord(segment));
    if (name === '') continue;
    const words = wordsOf(segment);
    const at = words.findIndex((word) => nameOf(basename(word)) === name);
    const after = words.slice(at + 1);
    if (name === 'cd' || name === 'pushd') {
      const path = writtenPath(
        after.find((word) => !/^-[A-Za-z@]*$/.test(word)),
        userHome,
      );
      if (path !== null) here = resolve(here, path);
    } else if (RUNS_PROJECT.has(name) || isProjectPath(words[at] ?? '')) {
      for (const option of FOLDER_OPTION[name] ?? []) {
        const index = after.indexOf(option);
        const path = index === -1 ? null : writtenPath(after[index + 1], userHome);
        if (path !== null) return resolve(here, path);
      }
      return here;
    }
  }
  return null;
}

/** The real path of a folder, so that two names of one folder are one folder. */
const realOf = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * The top of the repository a folder is in, or the folder when it is in none. The walk stops at the
 * home folder: dotfiles kept in git there do not make every folder below them one project.
 */
export function topOf(folder: string, userHome = ''): string {
  const start = realOf(folder);
  const home = userHome === '' ? '' : realOf(userHome);
  let at = start;
  for (let up = 0; up < MAX_UP; up += 1) {
    if (at === home) return at === start ? at : start;
    try {
      lstatSync(join(at, '.git'));
      return at;
    } catch {
      const parent = dirname(at);
      if (parent === at) break;
      at = parent;
    }
  }
  return start;
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
  const places = count === 1 ? '1 place' : `${count} places`;
  return `Stroq read this folder and found ${places} that run by themselves, run what they fetch, or hide what they do. It may be fine. Read them first: stroq inspect. If you have and they are fine, run this yourself in a terminal: stroq trust --folder .`;
}

/** The folder to look at for a command, or null for a command or a folder that is not looked at. */
function folderToRead(input: FolderCheckInput, userHome: string): string | null {
  const folder = folderOfCommand(input.command, input.cwd, userHome);
  if (folder === null) return null;
  const top = topOf(folder, userHome);
  return top === realOf(userHome) || top === parse(top).root ? null : top;
}

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
  const command = hashOf(input.command);

  if (marker?.signature === signature) {
    if (marker.pending.length === 0) return null;
    writeMarker(markerPath, { ...marker, command });
    return { ruleId: 'ask-foreign-folder', reason: marker.reason };
  }

  // Only the first command of a session in a folder pays for loading the readers.
  const { readFolder } = await import('./folder-reading.js');
  const { ids } = readFolder(top, options.budgetMs ?? BUDGET_MS);
  const known = marker?.known ?? [];
  const answered = new Set([
    ...known,
    ...(readTrustedFolders(trustedFoldersFileIn(options.home))[top] ?? []),
  ]);
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
  if (marker.command !== hashOf(input.command)) return;
  writeMarker(markerPath, {
    ...marker,
    known: [...new Set([...marker.known, ...marker.pending])],
    pending: [],
    reason: '',
  });
}
