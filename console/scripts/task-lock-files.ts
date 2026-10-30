import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isTaskId } from '@stroq/core';

export interface Pin {
  dev: string;
  ino: string;
  uid: string;
  mode: string;
}
export interface FilePin extends Pin {
  size: string;
  nlink: string;
  mtimeNs: string;
  ctimeNs: string;
}
export type FileCapture =
  { kind: 'missing' } | { kind: 'file'; pin: FilePin; sha256: string; text: string; bytes: Buffer };
export type FileBinding = { kind: 'missing' } | { kind: 'file'; pin: FilePin; sha256: string };
export type Marker = { kind: 'missing' } | { kind: 'present'; pin: FilePin };
export interface Options {
  project: string;
  userHome: string;
  home: string;
  workspaceId: string;
  runtimeSha256: string;
  engineVersion: string;
  platform?: string;
  now?: string;
  deadline?: number;
  configurationLockHeld?: boolean;
  rootBindings: {
    project: { path: string; dev: number; ino: number; uid: number; mode: number };
    user: { path: string; dev: number; ino: number; uid: number; mode: number };
  };
}
export interface Location {
  project: string;
  userHome: string;
  home: string;
  projectPin: Pin;
  userPin: Pin;
  homePin: Pin | null;
  tasksPin: Pin | null;
  keysPin: Pin | null;
}
export function fail(code: string): never {
  throw new Error(code);
}
export const hash = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export const same = isDeepStrictEqual;
const owner = typeof process.getuid === 'function' ? BigInt(process.getuid()) : null;
// The explicit structural type avoids depending on fs's overloaded inference.
type Stat = {
  dev: bigint;
  ino: bigint;
  uid: bigint;
  mode: bigint;
  size: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};
export const pin = (info: Pick<Stat, 'dev' | 'ino' | 'uid' | 'mode'>): Pin => ({
  dev: String(info.dev),
  ino: String(info.ino),
  uid: String(info.uid),
  mode: String(info.mode),
});
export const filePin = (info: Stat): FilePin => ({
  ...pin(info),
  size: String(info.size),
  nlink: String(info.nlink),
  mtimeNs: String(info.mtimeNs),
  ctimeNs: String(info.ctimeNs),
});
export const binding = (capture: FileCapture): FileBinding =>
  capture.kind === 'missing' ? capture : { kind: 'file', pin: capture.pin, sha256: capture.sha256 };
export const checkDeadline = (options: Options): void => {
  if (typeof options.deadline === 'number' && Date.now() >= options.deadline)
    fail('deadline-exceeded');
};

/** Root aliases are resolved once; every child directory remains canonical and owned. */
export async function directory(path: string, optional = false): Promise<Pin | null> {
  try {
    const info = await lstat(path, { bigint: true });
    if (
      !info.isDirectory() ||
      (owner !== null && info.uid !== owner) ||
      (info.mode & 0o022n) !== 0n ||
      (await realpath(path)) !== path
    )
      fail('unsafe-source');
    return pin(info);
  } catch (error) {
    if (optional && missing(error)) return null;
    throw error;
  }
}

export async function location(options: Options): Promise<Location> {
  if (!isAbsolute(options.project) || !isAbsolute(options.userHome) || !isAbsolute(options.home))
    fail('context-unavailable');
  const project = await realpath(options.project),
    userHome = await realpath(options.userHome);
  const projectPin = await directory(project),
    userPin = await directory(userHome);
  const match = (path: string, actual: Pin | null, expected: Options['rootBindings']['project']) =>
    expected &&
    path === expected.path &&
    actual !== null &&
    ['dev', 'ino', 'uid', 'mode'].every(
      (key) => actual[key as keyof Pin] === String(expected[key as keyof typeof expected]),
    );
  if (
    !match(project, projectPin, options.rootBindings?.project) ||
    !match(userHome, userPin, options.rootBindings?.user)
  )
    fail('context-unavailable');
  let home: string;
  try {
    home = await realpath(options.home);
  } catch (error) {
    if (!missing(error)) throw error;
    home = resolve(options.home);
  }
  const homePin = await directory(home, true);
  const tasksPin = homePin === null ? null : await directory(join(home, 'tasks'), true);
  const keysPin = homePin === null ? null : await directory(join(home, 'keys'), true);
  return {
    project,
    userHome,
    home,
    projectPin: projectPin!,
    userPin: userPin!,
    homePin,
    tasksPin,
    keysPin,
  };
}

export async function assertLocation(options: Options, expected: Location): Promise<void> {
  try {
    if (!same(await location(options), expected)) fail('preview-stale');
  } catch {
    fail('preview-stale');
  }
}

/** Bounded exact bytes, one handle, no symlink/hardlink or same-inode growth adoption. */
export async function file(path: string, limit: number): Promise<FileCapture> {
  let handle;
  try {
    const before = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (owner !== null && before.uid !== owner) ||
      (before.mode & 0o022n) !== 0n
    )
      fail('unsafe-source');
    if (before.size > BigInt(limit)) fail('source-limit');
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const first = await handle.stat({ bigint: true });
    if (!same(filePin(first), filePin(before))) fail('unsafe-source');
    const buffer = Buffer.alloc(Number(first.size) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const last = await handle.stat({ bigint: true }),
      named = await lstat(path, { bigint: true });
    if (
      filled !== Number(first.size) ||
      !same(filePin(first), filePin(last)) ||
      !same(filePin(last), filePin(named))
    )
      fail('unsafe-source');
    const bytes = buffer.subarray(0, filled);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail('invalid-source');
    }
    return { kind: 'file', pin: filePin(last), sha256: hash(bytes), text, bytes };
  } catch (error) {
    if (missing(error)) return { kind: 'missing' };
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function marker(path: string): Promise<Marker> {
  try {
    return { kind: 'present', pin: filePin(await lstat(path, { bigint: true })) };
  } catch (error) {
    if (missing(error)) return { kind: 'missing' };
    throw error;
  }
}

/** Only a bounded directory listing; no task ID from a browser ever becomes a path. */
export async function taskNames(root: Location) {
  if (root.tasksPin === null) return { names: [] as string[], limited: false };
  const names: string[] = [];
  let examined = 0,
    limited = false;
  const directory = await opendir(join(root.home, 'tasks'));
  try {
    for (;;) {
      const entry = await directory.read();
      if (entry === null) break;
      if (++examined > 256) {
        limited = true;
        break;
      }
      if (!isTaskId(entry.name)) continue;
      if (names.length === 64) {
        limited = true;
        break;
      }
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
  return { names: names.sort(), limited };
}
