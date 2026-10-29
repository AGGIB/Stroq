import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { splitCommand } from '../actions/shell-segments.js';
import { commandSegments } from '../actions/shell-top-level.js';
import { cloneFolder, extractionFolder, segmentWrites } from '../actions/script-writes.js';
import { resolve as resolveCommand } from '../actions/shell-words.js';

/**
 * The files a command downloads (`curl -o`, `curl -O`, `wget`, a redirect of a fetch) and the folders
 * it clones into, as absolute paths: read back later in the session, what they hold was written by
 * somebody else, however local the read (see `isOwnText`). A path a variable or a substitution makes
 * is not known and is left out.
 */
export const MAX_FETCHED = 64;
const MAX_COMMAND_CHARS = 64 * 1024;

const absolute = (path: string, cwd: string): string | null => {
  if (/[$`*?[]/.test(path) || path === '' || path === '-') return null;
  const expanded = path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
};

export function fetchedPaths(command: string, cwd: string): string[] {
  if (command.length > MAX_COMMAND_CHARS) return [];
  const out = new Set<string>();
  // Where the command is, as its own `cd`s move it: `cd docs && curl -O …` downloads into `docs`.
  let here = cwd;
  for (const segment of commandSegments(command, splitCommand(command))) {
    const found = resolveCommand(segment);
    const args = found === null ? [] : found.args.map((a) => a.value);
    if (found?.name === 'cd') {
      const to = args[0] === undefined ? null : absolute(args[0], here);
      if (to !== null) here = to;
      continue;
    }
    for (const write of segmentWrites(segment).writes) {
      if (write.source.kind !== 'fetched') continue;
      const path = absolute(write.path, here);
      if (path !== null) out.add(path);
    }
    if (found?.name === 'git' || found?.name === 'gh') {
      const folder = cloneFolder(args);
      const path = folder === null ? null : absolute(folder, here);
      if (path !== null) out.add(path);
    }
    // What an extraction in a line that downloaded something unpacks, where it says where.
    if (out.size > 0 && found !== null) {
      const folder = extractionFolder(found.name, args);
      const path = folder === null ? null : absolute(folder, here);
      if (path !== null) out.add(path);
    }
    if (out.size >= MAX_FETCHED) break;
  }
  return [...out].slice(0, MAX_FETCHED);
}

/** macOS and Windows name `Page.html` and `page.html` the same file. */
const fold = (path: string): string =>
  process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path;

/** Whether `path` is one of `fetched` or inside one (a clone's folder). */
export const inFetched = (path: string, fetched: readonly string[]): boolean => {
  const p = fold(path);
  return fetched.some((entry) => {
    const f = fold(entry);
    return p === f || p.startsWith(`${f}/`) || p.startsWith(`${f}\\`);
  });
};
