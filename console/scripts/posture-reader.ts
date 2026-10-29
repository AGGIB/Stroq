import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { SourceState } from '../lib/posture';
import { stripJsonComments } from './posture-analyzers';

/**
 * Reads one agent settings file for the settings check. Read-only, bounded, and careful about what
 * it opens: a file a repository ships is never followed through a link, and a path that leaves the
 * repository is refused. What comes back is the parsed value or a state; the text never leaves here.
 */

export const MAX_SETTINGS_BYTES = 256 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

export type SettingsFormat = 'json' | 'toml';
export type SettingsRead =
  | { readonly state: Exclude<SourceState, 'read'> }
  | { readonly state: 'read'; readonly value: unknown };

export interface SettingsTarget {
  readonly path: string;
  readonly format: SettingsFormat;
  /**
   * The folder a repository file must stay inside, or null for a file in your own home folder.
   * Your own files may be links (dotfile managers do that); a repository's may not.
   */
  readonly confineTo: string | null;
}

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';

const missing = (code: string): boolean => code === 'ENOENT' || code === 'ENOTDIR';

/** The same place by name, ignoring case where the file system does. */
const samePath = (a: string, b: string): boolean =>
  process.platform === 'darwin' || process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

async function readText(
  target: Pick<SettingsTarget, 'path' | 'confineTo'>,
): Promise<SettingsRead | string> {
  let path = target.path;
  if (target.confineTo !== null) {
    try {
      // A file a repository ships must be where its name says: a link in any part of the path, to
      // anywhere, makes the resolved path differ from the one built from the repository's own folder.
      const base = await realpath(target.confineTo);
      const expected = join(base, relative(target.confineTo, target.path));
      const real = await realpath(target.path);
      if (!samePath(real, expected)) return { state: 'unsafe' };
      path = real;
    } catch (error) {
      return { state: missing(codeOf(error)) ? 'missing' : 'unreadable' };
    }
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | NONBLOCK | (target.confineTo === null ? 0 : NOFOLLOW),
    );
  } catch (error) {
    const code = codeOf(error);
    if (missing(code)) return { state: 'missing' };
    return { state: code === 'ELOOP' ? 'unsafe' : 'unreadable' };
  }
  if (target.confineTo !== null) {
    // NOFOLLOW covers only the last part of the path. A folder swapped for a link between the check
    // above and the open would send the open elsewhere, so confirm that the name still leads to the
    // file that is open.
    try {
      const [again, now, opened] = await Promise.all([
        realpath(target.path),
        lstat(path),
        handle.stat(),
      ]);
      if (!samePath(again, path) || now.dev !== opened.dev || now.ino !== opened.ino) {
        await handle.close().catch(() => {});
        return { state: 'unsafe' };
      }
    } catch {
      await handle.close().catch(() => {});
      return { state: 'unsafe' };
    }
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { state: 'unsafe' };
    // A repository's file with another name elsewhere (a hard link) may be someone else's file.
    if (target.confineTo !== null && info.nlink !== 1) return { state: 'unsafe' };
    if (info.size > MAX_SETTINGS_BYTES) return { state: 'oversize' };
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    // The file grew while it was read.
    if (length > MAX_SETTINGS_BYTES) return { state: 'oversize' };
    return buffer.toString('utf8', 0, length);
  } catch {
    return { state: 'unreadable' };
  } finally {
    await handle.close().catch(() => {});
  }
}

/** The text of a file, read under the same rules, for a format this module does not parse. */
export async function readTextFile(
  target: Pick<SettingsTarget, 'path' | 'confineTo'>,
): Promise<SettingsRead> {
  const text = await readText(target);
  return typeof text === 'string' ? { state: 'read', value: text } : text;
}

export async function readSettingsFile(target: SettingsTarget): Promise<SettingsRead> {
  const text = await readText(target);
  if (typeof text !== 'string') return text;
  try {
    const value: unknown =
      target.format === 'toml' ? parseToml(text) : JSON.parse(stripJsonComments(text));
    return { state: 'read', value };
  } catch {
    // A parse error can carry a piece of the file in its message; none of it is kept.
    return { state: 'invalid' };
  }
}
