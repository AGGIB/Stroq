// The check of a folder, made once in a session, when an agent is about to run what is in it.
//
// `stroq inspect` reads a folder for a person who thought to ask. This is the same reading for the
// one who did not: the first time an agent in a session runs git or a command that runs the project's
// code, the folder is read, and what honest projects rarely do becomes a question to the person. It is
// a reading of text, so it never refuses anything and says nothing of what it did not see. What it
// cannot do is get in front of what an agent runs at its own startup, which is why `inspect` stays.
//
// The hook is a process of its own for each call, and most calls trigger nothing: only the words of
// the command are looked at until one does, and the readers are loaded then.
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
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
const MARKER_MAX = 4096;
/** The most folders walked up to find the top of a repository. */
const MAX_UP = 32;
const PLACES_SAID = 2;

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
]);

/** The written path of a `cd`, or null when the shell would have to work it out. */
function literalPath(word: string | undefined): string | null {
  if (word === undefined || word === '') return null;
  const inner = /^(["'])(.*)\1$/.exec(word)?.[2] ?? word;
  return /[$`*?~<>(){}\\|;&]|^-/.test(inner) ? null : inner;
}

/** The words of a segment, with a quoted run kept as one. */
const wordsOf = (segment: string): string[] => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

/** Where a command runs git or the project's code, or null when it does neither. */
export function folderOfCommand(command: string, cwd: string): string | null {
  let here = cwd;
  for (const segment of splitSegments(command)) {
    const word = commandWord(segment)
      .toLowerCase()
      .replace(/\.(?:exe|cmd)$/, '');
    if (word === 'cd') {
      const path = literalPath(wordsOf(segment)[1]);
      if (path !== null) here = resolve(here, path);
    } else if (RUNS_PROJECT.has(word)) {
      if (word === 'git') {
        const words = wordsOf(segment);
        const at = words.indexOf('-C');
        const path = at === -1 ? null : literalPath(words[at + 1]);
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

/** The top of the repository a folder is in, or the folder when it is in none. */
export function topOf(folder: string): string {
  let at = realOf(folder);
  for (let up = 0; up < MAX_UP; up += 1) {
    try {
      lstatSync(join(at, '.git'));
      return at;
    } catch {
      const parent = dirname(at);
      if (parent === at) break;
      at = parent;
    }
  }
  return realOf(folder);
}

const stamp = (path: string): string => {
  try {
    const { mtimeMs, size } = lstatSync(path);
    return `${mtimeMs}:${size}`;
  } catch {
    return '-';
  }
};

/** Files whose change means the folder was updated. Git touches these on a fetch, a merge or a new hook. */
const WATCHED = [
  '.git/config',
  '.git/hooks',
  '.git/HEAD',
  '.git/FETCH_HEAD',
  '.git/ORIG_HEAD',
  'package.json',
  'Makefile',
];

/** What changes when a folder is updated, cheap enough for every call that triggers. */
const signatureOf = (top: string): string =>
  WATCHED.map((name) => stamp(join(top, name))).join('|');

interface Marker {
  readonly signature: string;
  readonly found: string;
}

function readMarker(path: string): Marker | null {
  try {
    const read = readRegularFile(path, MARKER_MAX, { noFollow: true });
    if (read.kind !== 'text') return null;
    const value: unknown = JSON.parse(read.text);
    if (typeof value !== 'object' || value === null) return null;
    const { signature, found } = value as Record<string, unknown>;
    return typeof signature === 'string' && typeof found === 'string' ? { signature, found } : null;
  } catch {
    return null;
  }
}

function writeMarker(path: string, marker: Marker): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(marker), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Not being able to remember costs a second question, and never a question not asked.
  }
}

const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The question to ask before this command runs, or null. Reads; runs nothing. */
export async function checkFolder(
  input: FolderCheckInput,
  options: FolderCheckOptions,
): Promise<FolderQuestion | null> {
  const folder = folderOfCommand(input.command, input.cwd);
  if (folder === null) return null;
  const top = topOf(folder);
  if (top === options.userHome || top === parse(top).root) return null;

  const markerPath = join(
    options.home,
    MARKERS,
    `${hashOf(`${input.sessionId}\0${top}`).slice(0, 32)}.json`,
  );
  const marker = readMarker(markerPath);
  const signature = signatureOf(top);
  if (marker?.signature === signature) return null;

  // Only the first command of a session in a folder pays for loading the readers.
  const { readFolder } = await import('./folder-reading.js');
  const { places, found } = readFolder(top, options.budgetMs ?? BUDGET_MS);
  writeMarker(markerPath, { signature, found });
  if (places.length === 0 || marker?.found === found) return null;
  if (readTrustedFolders(trustedFoldersFileIn(options.home))[top] === found) return null;

  const more = places.length - PLACES_SAID;
  return {
    ruleId: 'ask-foreign-folder',
    reason: `This folder holds code that runs by itself, runs what it fetches, or hides what it does: ${places
      .slice(0, PLACES_SAID)
      .join(
        ', ',
      )}${more > 0 ? `, and ${more} more` : ''}. It may be fine. Read it before running anything here: stroq inspect. If you have and it is fine: stroq trust --folder .`,
  };
}
