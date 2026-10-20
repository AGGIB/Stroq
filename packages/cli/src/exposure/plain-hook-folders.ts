import { lstatSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { runsFetchedOrHiddenCode, sendsSecrets } from './fetch-shapes.js';
import type { RepoExecHit } from './repo-surface.js';

/**
 * The git hooks of a folder on disk that a commit runs: husky's, a `.githooks` folder's, and those
 * of a folder `core.hooksPath` names, in git's own config or in a script of package.json. Each is
 * read as text: one that downloads and runs code, runs hidden code or sends a secret out fails
 * before anyone commits, and so does one that is a link, cannot be read, or comes past the files
 * read. Any other is listed. A script that points `core.hooksPath` somewhere this cannot place
 * (a `$`, a quote around a blank, `~`, an absolute path) fails too.
 */

/** What sets `core.hooksPath` in a script: `git config core.hooksPath <folder>`. */
const SETS_HOOKS_PATH = /core\.hookspath["']?(?:\s*=\s*|\s+)([^\s;&|)]+)/gi;
/** A plain relative path: no quote, blank, `$`, backquote or `~`, and not absolute. */
const PLAIN_PATH = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;
/** The most bytes of one hook read; a longer one is not read, and fails. */
const MAX_HOOK_BYTES = 256 * 1024;
/** The most files of one folder read; past them, one finding fails. */
const MAX_HOOK_FILES = 200;

/** Why a hook fails before anyone commits. */
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
  try {
    if (lstatSync(path).isSymbolicLink()) return failing('a link, which was not read');
    const read = readRegularFile(path, MAX_HOOK_BYTES);
    if (read.kind !== 'text') return failing('which could not be read as text');
    if (runsFetchedOrHiddenCode(read.text) || sendsSecrets(read.text))
      return failing(RUNS_ON_COMMIT);
  } catch {
    return failing('which could not be read');
  }
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
  for (const script of scripts)
    for (const match of script.matchAll(SETS_HOOKS_PATH)) {
      const folder = placed(match[1] as string);
      if (folder !== undefined) folders.add(folder);
      else
        out.push({
          kind: 'git-hook-routine',
          file: 'package.json',
          what: `a script points core.hooksPath at ${match[1] as string}, a folder this does not place, so its hooks were not read`,
        });
    }
  return [...out, ...[...folders].flatMap((folder) => folderHits(root, folder))];
}
