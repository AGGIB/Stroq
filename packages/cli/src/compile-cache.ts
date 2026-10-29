import { accessSync, constants, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import module from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileCacheDirIn, stroqHome } from './paths.js';
import { stroqVersion } from './version.js';

/**
 * Node's on-disk cache of compiled code, turned on for the modules loaded after this call.
 *
 * Every hook call is a new process, and before this one parsed and compiled the whole bundle again:
 * about half of the time a PreToolUse spent. With the cache, V8 reads back the code it compiled for
 * the same file the last time, and only compiles what is new.
 *
 * What is in the cache is V8's compiled code, and Node runs it as the module. Node checks each entry
 * against a CRC32 of the source it was made from, so a stale entry (another version, an edited file)
 * is thrown away and compiled again; but a CRC32 is not a signature, and whoever can write an entry
 * can make one that matches and holds code of their own, which then runs inside the firewall. So the
 * cache is used only where it is exactly as protected as `policy.yaml`, and otherwise not at all:
 *
 * - Only in the default home, `~/.stroq`, whose paths the self-tamper gate refuses writes to and
 *   which `stroq run --sandbox` denies (`run/sandbox.ts`). A `STROQ_HOME` elsewhere is a path the
 *   gate does not match, so it runs uncached. Not Node's own default either, `<tmpdir>/node-compile-cache`:
 *   an agent writes there with an ordinary command, and on Linux any local user can make it first.
 * - Only where the home, `compile-cache`, the version's folder and what Node made in it are all real
 *   directories (no link), owned by this user, that no group or other user can write. The two folders
 *   Stroq makes are made 0700 and must still be 0700. A folder that fails is never repaired, since
 *   that would trust whatever is already in it: the call runs uncached.
 * - Only where this user can already write the code it caches (the folder of the running bundle).
 *   Under a root-owned global install the agent cannot touch the code, and a cache it could reach
 *   past the gate, which reads only how a path is spelled, would be the weakest point.
 * - Not where those checks cannot be made: on Windows there is no owner id to compare, and the ACL
 *   is not read, so it runs uncached there.
 * - Not when the environment chose: `NODE_DISABLE_COMPILE_CACHE` leaves it off and makes nothing,
 *   and with `NODE_COMPILE_CACHE` Node has already turned it on in that folder before Stroq starts.
 *   That is the environment's choice, as `NODE_OPTIONS` is.
 *
 * It is never the reason a home exists: where there is none yet, nothing is made, and the cache
 * starts with the call after the one that made it. A command that writes nothing leaves nothing.
 *
 * A cache that cannot be used is not an error. Node before 22.1 has no `enableCompileCache`; a
 * sandbox that denies the folder, or anything that fails, leaves Stroq compiling its code as it
 * always did, a little slower.
 */
export function enableCompileCache(
  home: string = stroqHome(),
  version: () => string = stroqVersion,
  host: CompileCacheHost = defaultHost(),
): string | null {
  const { enable, uid } = host;
  if (typeof enable !== 'function' || uid === undefined) return null;
  if (host.env['NODE_DISABLE_COMPILE_CACHE'] || host.env['NODE_COMPILE_CACHE']) return null;
  try {
    if (resolve(home) !== resolve(host.defaultHome)) return null;
    accessSync(host.codeDir, constants.W_OK);
    const name = version();
    if (!VERSION_FOLDER.test(name)) return null;
    if (!isPrivateDir(home, uid, SHARED_READ)) return null;
    const root = compileCacheDirIn(home);
    makeDir(root);
    if (!isPrivateDir(root, uid, OWNER_ONLY)) return null;
    const dir = join(root, name);
    const made = makeDir(dir);
    if (!isPrivateDir(dir, uid, OWNER_ONLY)) return null;
    if (!holdsOnlyPrivateDirs(dir, uid)) return null;
    if (made) pruneOtherVersions(root, dir, host.now?.() ?? Date.now());
    // Node makes its own folder in `dir` now, with the umask; 077 makes it 0700 whatever the user's is.
    const status = withUmask(0o077, () => enable(dir)) as { readonly status?: number } | undefined;
    return status?.status === ENABLED ? dir : null;
  } catch {
    return null;
  }
}

/** `module.constants.compileCacheStatus.ENABLED`: the call turned the cache on, in our folder. */
const ENABLED = 1;

/**
 * What stands in a version folder: Node's own (`v<node>-<arch>-<flags>-<uid>`) and nothing it could
 * be sent elsewhere by. A link fails, and so does a folder that is not a private one of ours. A plain
 * file (a `.DS_Store`) is inert: Node reads only its own folder, and cannot make it where a file is.
 */
function holdsOnlyPrivateDirs(dir: string, uid: number): boolean {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = lstatSync(path);
    if (info.isFile()) continue;
    if (!isPrivateDir(path, uid, SHARED_READ)) return false;
  }
  return true;
}

/** Runs `work` with the process umask set to `mask`, and puts the old one back. */
function withUmask<T>(mask: number, work: () => T): T {
  const before = process.umask(mask);
  try {
    return work();
  } finally {
    process.umask(before);
  }
}

export interface CompileCacheHost {
  /** `module.enableCompileCache`, absent on Node 22.0. */
  readonly enable: ((dir: string) => unknown) | undefined;
  /** This user's id; absent on Windows, where the cache is not used. */
  readonly uid: number | undefined;
  /** The one home the self-tamper gate protects by its path: `~/.stroq`. */
  readonly defaultHome: string;
  /** The folder of the code being run, which this user must be able to write already. */
  readonly codeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}

function defaultHost(): CompileCacheHost {
  return {
    enable: (module as { enableCompileCache?: (dir: string) => unknown }).enableCompileCache,
    uid: process.getuid?.(),
    defaultHome: join(homedir(), '.stroq'),
    // This file is bundled into `dist/index.js`, beside every chunk of the CLI.
    codeDir: dirname(fileURLToPath(import.meta.url)),
    env: process.env,
  };
}

/** No write for the group or others: what a home made under a 022 umask, and Node's folder, have. */
const SHARED_READ = 0o022;
/** Nothing for the group or others: the 0700 Stroq makes its two folders with. */
const OWNER_ONLY = 0o077;

/** A directory itself, not a link to one, owned by `uid`, with none of the `forbidden` mode bits. */
function isPrivateDir(path: string, uid: number, forbidden: number): boolean {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return (
    info !== undefined && info.isDirectory() && info.uid === uid && (info.mode & forbidden) === 0
  );
}

/** Makes one folder, 0700, if nothing is there; says whether it did. Never makes a parent. */
function makeDir(path: string): boolean {
  try {
    mkdirSync(path, { mode: 0o700 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/**
 * How long a folder of another version is kept. Node never deletes an entry, and every release
 * brings new files (the bundle's chunks are named by their content), so without this the cache
 * would grow by a few megabytes with each upgrade. Two versions can run side by side for good (the
 * plugin's pinned copy and a global install), and deleting the other's folder on every first run
 * would make them take turns rebuilding it, so only a folder nothing has added to for a week goes.
 */
export const OTHER_VERSION_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** Only names a version folder can have: nothing else under the home is touched. */
const VERSION_FOLDER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * When anything was last added to a version folder. Node writes its entries into its own folder
 * inside it, which leaves the version folder's own time where it was when it was made.
 */
function lastWritten(dir: string): number {
  let newest = lstatSync(dir).mtimeMs;
  for (const name of readdirSync(dir))
    newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs);
  return newest;
}

/** Runs once per version and home, when that version's folder is first made. Never throws. */
function pruneOtherVersions(root: string, keep: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(root, name);
    if (path === keep || !VERSION_FOLDER.test(name)) continue;
    try {
      // `lstat`: a link is not a folder of ours, whatever it points at.
      const info = lstatSync(path);
      if (info.isDirectory() && now - lastWritten(path) > OTHER_VERSION_KEPT_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove: the next new version tries again.
    }
  }
}

/**
 * Makes `<home>/compile-cache`, 0700, before `stroq run --sandbox` writes its config. A name the
 * config denies is denied whether or not it exists on macOS, but elsewhere only one that exists is
 * listed (`run/sandbox.ts`), and an agent inside the sandbox could make this one first and fill it.
 * Made here, it exists and is denied. Something already there is left as it is: if it is not a
 * private folder, `enableCompileCache` does not use it.
 */
export function makeCompileCacheRoot(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  makeDir(compileCacheDirIn(home));
}
