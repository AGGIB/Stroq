// The URL a git remote points at, read from the repository's config file.
//
// `git push origin` names a remote, not a host. The host is in `.git/config`, which is read
// here as a file: no git process is started, and only `[remote "<name>"]` `url` lines are
// taken. The config may have changed since the session pushed, which a report says.
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readSmall } from './regular-file.js';

/** Folders walked up from a session's folder to find its repository. */
const MAX_DEPTH = 32;
const MAX_CONFIG_BYTES = 1024 * 1024;

/** A config file's text; null for a missing one, a folder, a FIFO or a device, or one too large. */
const readConfig = (path: string): string | null => readSmall(path, MAX_CONFIG_BYTES);

/** The config file of the repository `dir` is in, following a worktree's `.git` file. */
function configOf(dir: string): string | null {
  let current = resolve(dir);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const dotGit = join(current, '.git');
    const direct = readConfig(join(dotGit, 'config'));
    if (direct !== null) return direct;
    const pointer = readConfig(dotGit);
    if (pointer !== null && pointer.startsWith('gitdir:')) {
      const raw = pointer.slice('gitdir:'.length).trim();
      const gitdir = isAbsolute(raw) ? raw : resolve(current, raw);
      const common = readConfig(join(gitdir, 'commondir'))?.trim();
      const base = common === undefined || common === '' ? gitdir : resolve(gitdir, common);
      return readConfig(join(base, 'config'));
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** `url` of `[remote "<name>"]` in a config's text. */
function remoteUrl(config: string, name: string): string | null {
  let inside = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inside = line === `[remote "${name}"]`;
      continue;
    }
    if (!inside || !line.startsWith('url')) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(3, eq).trim() !== '') continue;
    const url = line.slice(eq + 1).trim();
    if (url !== '') return url;
  }
  return null;
}

/** A reader that remembers each folder's config for the length of one run. */
export function gitRemoteReader(): (cwd: string | null, name: string) => string | null {
  const configs = new Map<string, string | null>();
  return (cwd, name) => {
    if (cwd === null || cwd === '') return null;
    if (!configs.has(cwd)) configs.set(cwd, configOf(cwd));
    const config = configs.get(cwd) ?? null;
    return config === null ? null : remoteUrl(config, name);
  };
}
