// Directories the live check may delete from and overwrite in, and the proof that a directory is one.
//
// The check clears files before a request, writes a policy and a made-up key, and (later) removes what
// it made. All of that is done to directories its caller names, and a caller can be wrong: a past test
// of this project deleted its owner's configuration with a real `rm -rf ~`. So nothing here is trusted
// to be disposable because of what it is called. A directory is disposable if the check made it, in the
// temporary directory, with a marker file in its root, and if it is not, or does not hold, anything the
// owner would miss: the real Stroq home, the home directory, the directory the process is working in.
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stroqHome } from '../paths.js';
import { LiveCheckError } from './errors.js';

/** The file whose presence in the root of a directory makes everything below it disposable. */
export const THROWAWAY_MARKER = '.stroq-live-throwaway';

/** What `mkdtemp` is given before the random part: plain characters and never a place. */
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

const MARKER_TEXT = 'made by stroq prove: everything in this directory may be removed\n';

/** The directories of one live check. All of them are below `root`, which carries the marker. */
export interface Throwaway {
  readonly root: string;
  /** Where the host is started, and where the made-up key and the probe files go. */
  readonly project: string;
  /** The HOME the hook runs with. */
  readonly home: string;
  /** The STROQ_HOME the hook writes its audit log and sessions to, and reads its policy from. */
  readonly stroqHome: string;
}

/**
 * Makes a root in the temporary directory, marks it, and makes `project/`, `home/` and `stroq-home/` in
 * it. `prefix` is plain characters; the rest of the name is random.
 */
export function createThrowawayRoot(prefix: string): Throwaway {
  if (typeof prefix !== 'string' || !PREFIX.test(prefix))
    throw new LiveCheckError(
      'invalid-option',
      'not a prefix for the name of a throwaway directory',
    );
  const root = mkdtempSync(join(tmpdir(), prefix));
  const made: Throwaway = {
    root,
    project: join(root, 'project'),
    home: join(root, 'home'),
    stroqHome: join(root, 'stroq-home'),
  };
  try {
    writeFileSync(join(root, THROWAWAY_MARKER), MARKER_TEXT, { mode: 0o600, flag: 'wx' });
    for (const dir of [made.project, made.home, made.stroqHome]) mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    // The root was made a moment ago by this call and holds nothing but what this call put there.
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return made;
}

/** Text from outside as it may be put in a message: plain characters, one line, short. */
const shown = (text: unknown): string =>
  String(text)
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 100);

const gone = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/**
 * The real path of `path`, with every link in it followed, for a path that need not exist: the part that
 * does is resolved and the rest is put back on, so that a directory about to be made is judged by where
 * it will be.
 */
function resolveReal(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest);
    } catch (err) {
      const up = dirname(head);
      if (!gone(err) || up === head) throw err;
      rest.unshift(basename(head));
      head = up;
    }
  }
}

/** True when `inner` is `outer` or is below it. Both are real paths. */
function within(inner: string, outer: string): boolean {
  const way = relative(outer, inner);
  return way === '' || (way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way));
}

const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/** What no throwaway directory may be or hold, with the words for it. Each is looked up when asked. */
const PROTECTED: ReadonlyArray<readonly [string, () => string]> = [
  ['the Stroq home', stroqHome],
  ['the home directory', homedir],
  ['the working directory', () => process.cwd()],
];

/**
 * Throws the typed error `unsafe-directory`, saying why, unless `dir` is a throwaway one. It is when its
 * real path is strictly inside the real path of the temporary directory, the root it is in (the first
 * directory below the temporary one) carries the marker as a file of its own, and it neither is nor
 * holds the real Stroq home, the home directory or the working directory. It need not exist yet.
 *
 * The answer is about the directory now. A host running in it could change what is in it afterwards,
 * which is why nothing is run while the check clears and writes, and why `clearSentinel` looks at links
 * on the way to the file again.
 */
export function assertThrowaway(dir: string): void {
  const refuse = (why: string): never => {
    throw new LiveCheckError('unsafe-directory', `will not touch ${shown(dir)}: ${why}`);
  };
  if (typeof dir !== 'string' || dir === '' || dir.includes('\u0000'))
    return refuse('it is not a path');
  if (!isAbsolute(dir)) return refuse('it is not an absolute path');
  let real: string;
  try {
    real = resolveReal(dir);
  } catch {
    return refuse('its real path cannot be found out');
  }
  if (dirname(real) === real) return refuse('it is the root of the file system');
  for (const [name, find] of PROTECTED) {
    let place: string;
    try {
      place = resolveReal(find());
    } catch {
      // No working directory (it was removed) or a home that is not there: nothing to hold.
      continue;
    }
    if (within(place, real)) return refuse(`it is, or holds, ${name}`);
  }
  let temporary: string;
  try {
    temporary = realpathSync(tmpdir());
  } catch {
    return refuse('the temporary directory cannot be found');
  }
  if (real === temporary || !within(real, temporary))
    return refuse('it is not inside the temporary directory');
  const rootName = relative(temporary, real).split(sep)[0] ?? '';
  if (!isRegularFile(join(temporary, rootName, THROWAWAY_MARKER)))
    return refuse('it is not below a directory with the throwaway marker');
}

/**
 * Removes a whole throwaway root. Refuses, as `assertThrowaway` does, anything that is not one, and
 * refuses a directory inside one: the root goes as a whole or not at all. A root that is already gone
 * is nothing to remove.
 */
export function removeThrowawayRoot(root: string): void {
  try {
    lstatSync(root);
  } catch (err) {
    if (gone(err) && typeof root === 'string' && isAbsolute(root)) return;
  }
  assertThrowaway(root);
  const real = resolveReal(root);
  if (dirname(real) !== realpathSync(tmpdir()))
    throw new LiveCheckError(
      'unsafe-directory',
      `will not remove ${shown(root)}: it is inside a root, and only a whole root is removed`,
    );
  rmSync(real, { recursive: true, force: true });
}
