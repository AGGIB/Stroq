import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { hookOutcome } from './hook-outcome.js';
import type { RepoExecHit } from './repo-surface.js';

/**
 * The git hooks of a folder on disk that a commit runs: husky's, a `.githooks` folder's, a folder
 * `core.hooksPath` names, in git's own config or in a script of package.json, and the folder a
 * script tells husky to use. Each file is taken as one in `.git/hooks` is (see `hookOutcome`): a
 * file that is not a commit hook, or a commit hook that downloads and runs code, runs hidden code
 * or sends a secret out, fails before anyone commits, and so does one that is a link, cannot be
 * read, or comes past the files read. Any other is listed. A script that mentions
 * `core.hooksPath`, its quotes and backslashes taken off, and points it at no folder this can
 * place (a `$`, a quote around a blank, `~`, an absolute path, a key spelled with quotes) fails.
 */

/** What sets `core.hooksPath` in a script: `git config core.hooksPath <folder>`. */
const SETS_HOOKS_PATH = /core\.hookspath["']?(?:\s*=\s*|\s+)([^\s;&|)]+)/gi;
/** What tells husky which folder to use: `husky <folder>` or `husky install <folder>`. */
const HUSKY_FOLDER = /(?:^|[\s;&|(])husky(?:\s+install)?\s+([^\s;&|)]+)/gi;
/** A mention of the key, however it is spelled, once quotes and backslashes are taken off. */
const MENTIONS_HOOKS_PATH = /hookspath/g;
/** A plain relative path: no quote, blank, `$`, backquote or `~`, and not absolute. */
const PLAIN_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;
/** The most bytes of one hook read; a longer one is not read, and fails. */
const MAX_HOOK_BYTES = 256 * 1024;
/** The most files of one folder read; past them, one finding fails. */
const MAX_HOOK_FILES = 200;

/** Why a commit hook fails before anyone commits. */
const RUNS_ON_COMMIT =
  'which a commit runs, and whose text downloads and runs code or sends a secret out';

/** A folder named by a value of `core.hooksPath`, or undefined when it cannot be placed. */
function placed(value: string): string | undefined {
  const quoted = /^(["'])(.*)\1$/.exec(value.trim());
  const text = quoted === null ? value.trim() : (quoted[2] as string);
  if (!PLAIN_PATH.test(text)) return undefined;
  const folder = posix.normalize(text).replace(/\/+$/, '');
  return folder === '..' || folder.startsWith('../') ? undefined : folder;
}

/** What a hook file is: listed, or failing with why. */
function hookHit(root: string, folder: string, name: string, husky: boolean): RepoExecHit {
  const file = `${folder}/${name}`;
  const failing = (why: string): RepoExecHit => ({
    kind: 'git-hook-routine',
    file,
    what: `${name}, ${why}`,
  });
  const path = join(root, folder, name);
  let text: string | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) return failing('a link, which was not read');
    const read = readRegularFile(path, MAX_HOOK_BYTES);
    text = read.kind === 'text' ? read.text : undefined;
  } catch {
    text = undefined;
  }
  const outcome = hookOutcome(name, text);
  if (outcome === 'routine') return { kind: 'git-hook-routine', file, what: name };
  if (outcome === 'unsafe')
    return failing(text === undefined ? 'which could not be read' : RUNS_ON_COMMIT);
  return husky ? { kind: 'husky-hook', file, what: name } : { kind: 'git-hook', file, what: name };
}

/** The hook files of one folder: the files in it, but husky's own `_` folder and dot files. */
function folderHits(root: string, folder: string): RepoExecHit[] {
  let names: string[];
  try {
    names = readdirSync(join(root, folder), { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && !e.name.startsWith('_') && !e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const husky = folder === '.husky';
  const hits = names.slice(0, MAX_HOOK_FILES).map((name) => hookHit(root, folder, name, husky));
  const cut = names[MAX_HOOK_FILES];
  if (cut !== undefined)
    hits.push({
      kind: 'git-hook-routine',
      file: `${folder}/${cut}`,
      what: `${names.length - MAX_HOOK_FILES} more hook files, which were not read`,
    });
  return hits;
}

/**
 * The hooks of every folder a commit may run them from. `hooksPaths` are the values git's own
 * config gives `core.hooksPath`; `scripts` the commands of package.json.
 */
export function plainHookHits(
  root: string,
  hooksPaths: readonly string[],
  scripts: readonly string[],
): RepoExecHit[] {
  const folders = new Set(['.husky', '.githooks']);
  const out: RepoExecHit[] = [];
  for (const value of hooksPaths) {
    const folder = placed(value);
    if (folder !== undefined) folders.add(folder);
  }
  const unplaced = (value: string): void => {
    out.push({
      kind: 'git-hook-routine',
      file: 'package.json',
      what: `a script points git at hooks in ${value}, a folder this cannot place, so its hooks were not read`,
    });
  };
  for (const script of scripts) {
    // Every mention must be one the exact reading placed; a spelling it cannot read fails.
    const mentions = script
      .toLowerCase()
      .replace(/["'\\]/g, '')
      .match(MENTIONS_HOOKS_PATH);
    let placedCount = 0;
    let failed = false;
    for (const match of script.matchAll(SETS_HOOKS_PATH)) {
      const folder = placed(match[1] as string);
      if (folder === undefined) {
        unplaced(match[1] as string);
        failed = true;
      } else {
        folders.add(folder);
        placedCount += 1;
      }
    }
    if (!failed && (mentions?.length ?? 0) > placedCount)
      unplaced('a core.hooksPath this does not read');
    for (const match of script.matchAll(HUSKY_FOLDER)) {
      const value = match[1] as string;
      if (value.startsWith('-')) continue;
      const folder = placed(value);
      if (folder === undefined) unplaced(value);
      else folders.add(folder);
    }
  }
  return [...out, ...[...folders].flatMap((folder) => folderHits(root, folder))];
}
