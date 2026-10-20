// Which recorded sessions are this project's: the ones `--here` reads, and the one `--last`
// checks is not another project's.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { directoryAndParents, projectSlug } from '../replay/transcript.js';
import type { SessionRef } from './sessions.js';

/**
 * `path` with symlinks resolved as far as it exists: a project reached through a link
 * (`/var` → `/private/var` on macOS) is the same project, and a recorded file that has
 * since been deleted is resolved through the nearest directory that is still there.
 */
function real(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(real(parent), basename(absolute));
  }
}

/** Whether `dir` is `root` or somewhere inside it. */
function isWithin(dir: string, root: string): boolean {
  const rel = relative(real(root), real(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Whether a session recorded at `recorded` is this directory's. Either contains the other: a
 * session that ran in a directory containing this one is the same project, and Cursor records
 * the files a session touched rather than a working directory, so its `cwd` is a path inside
 * the project. The home directory, or anything above it, contains every project and is none.
 */
export function sessionBelongsHere(cwd: string, recorded: string): boolean {
  if (isWithin(recorded, cwd)) return true;
  if (!isWithin(cwd, recorded)) return false;
  return !isWithin(homedir(), recorded);
}

/**
 * Whether a session is this project's: by the folder its records name, or, when they name none,
 * by the Claude Code project folder it is filed under, which is that folder as a slug.
 */
export function belongsHere(run: {
  readonly cwd: string;
  readonly home: string;
}): (ref: SessionRef) => boolean {
  const slugs = new Set(directoryAndParents(run.cwd, run.home).map(projectSlug));
  return (ref) =>
    ref.cwd !== null
      ? sessionBelongsHere(run.cwd, ref.cwd)
      : ref.project !== undefined && slugs.has(ref.project);
}
