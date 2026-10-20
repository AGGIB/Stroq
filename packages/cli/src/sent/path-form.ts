// Paths as `stroq sent` compares them: one spelling, whatever system the check runs on.
//
// A session's paths are spelled by the system it ran on and by the shell the agent used. On
// Windows a key file is `C:\Users\u\.env`, while a command in Git Bash names it
// `C:/Users/u/.env` or `~/.env`. `node:path` reads only its own system's spelling, so every path
// compared here is read in one: a backslash is a slash, as `call-facts.ts` already reads a
// program's name, and a drive letter is upper case. A path from a root is absolute on either
// system: `/w`, `C:/w`, `C:\w`, `\\server\share`. Only paths compared are spelled so: a file is
// still opened by the path this machine gave.
import { posix } from 'node:path';

/** A drive letter that starts a path from a root: `C:` before a slash, or alone. */
const DRIVE = /^[A-Za-z]:(?=\/|$)/;

/** A path with a slash between its folders and its drive letter, if any, in upper case. */
export function slashed(path: string): string {
  const s = path.replace(/\\/g, '/');
  return /^[a-z]:/.test(s) ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}

/** The drive a slashed path starts with (`C:`), or nothing. */
export const driveOf = (path: string): string => DRIVE.exec(path)?.[0] ?? '';

/** Whether a path starts at a root, in either system's spelling. */
export const isAbsolutePath = (path: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(path);

/**
 * A path with its `.` and `..` parts read, as `normalize` reads it, slashed, in time linear in its
 * length: `normalize` is quadratic in the `..` that lead a relative path, and the path is the
 * agent's. A drive is kept, and `..` stops at it.
 */
export function normalPath(path: string): string {
  const s = slashed(path);
  const drive = driveOf(s);
  const rest = s.slice(drive.length);
  if (rest.startsWith('/')) return `${drive}${posix.normalize(rest)}`;
  if (drive !== '') return `${drive}/`;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  const joined = parts.join('/');
  return joined === '' ? '.' : joined;
}

/** A relative path read against a folder, slashed, with its `.` and `..` read. */
export function joinPath(folder: string, path: string): string {
  const base = slashed(folder);
  const drive = driveOf(base);
  return `${drive}${posix.join(base.slice(drive.length) || '/', slashed(path))}`;
}

/** The last part of a path, in either system's spelling. */
export const baseName = (path: string): string => posix.basename(slashed(path));
