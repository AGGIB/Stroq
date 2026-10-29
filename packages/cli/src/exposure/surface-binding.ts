import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export type SurfaceRole = 'workspace' | 'git-metadata';
export type SurfaceGapCode =
  | 'unreadable'
  | 'invalid-utf8'
  | 'not-regular'
  | 'too-large'
  | 'limit'
  | 'outside-root'
  | 'source-changed'
  | 'unparsed'
  | 'git-metadata-unverified'
  /** The workspace has no `.git` and sits inside a repository whose metadata was not read. */
  | 'enclosing-repository'
  /** A `.git` below the root of a repository workspace, whose metadata was not read. */
  | 'nested-repository';
export interface SurfaceObservation {
  code: SurfaceGapCode;
  path: string;
  role: SurfaceRole;
}
export interface SurfaceSource {
  kind: 'file' | 'directory' | 'link';
  path: string;
  role: SurfaceRole;
  sha256: string;
  mode: number;
}
export interface SurfaceExclusion {
  reason: 'stroq-data';
  path: string;
  sha256: string;
}
export interface SurfaceLimits {
  maxBytes?: number;
  maxFiles?: number;
  maxDirectories?: number;
  maxEntries?: number;
  maxObservations?: number;
}
export interface SurfacePin {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}
export type SurfaceDependency = {
  path: string;
  pin: SurfacePin | null;
  kind: 'stat' | 'directory' | 'file' | 'link';
  sha256?: string;
  namesSha256?: string;
  entryCount?: number;
  listingComplete?: boolean;
  target?: string;
};
export interface SurfaceBinding {
  version: 1;
  root: string;
  dependencies: SurfaceDependency[];
  sha256: string;
}
export const surfaceHash = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');
export const surfaceWithin = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
export const surfacePin = (stat: Stats): SurfacePin => ({
  dev: stat.dev,
  ino: stat.ino,
  mode: stat.mode,
  uid: stat.uid,
  nlink: stat.nlink,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  ctimeMs: stat.ctimeMs,
});
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const failure = (code: string): Error & { code: string } =>
  Object.assign(new Error(code), { code });

/** No content is retained in the binding. A new capture is required after any dependency changes. */
export function recheckWorkspaceSurface(binding: SurfaceBinding): boolean {
  try {
    if (
      binding.version !== 1 ||
      surfaceHash(JSON.stringify(binding.dependencies)) !== binding.sha256 ||
      realpathSync(binding.root) !== binding.root
    )
      return false;
    for (const item of binding.dependencies) {
      let stat: Stats;
      try {
        stat = lstatSync(item.path);
      } catch (error) {
        if (item.pin === null && absent(error)) continue;
        return false;
      }
      if (item.pin === null || !same(surfacePin(stat), item.pin)) return false;
      if (item.kind === 'link' && readlinkSync(item.path) !== item.target) return false;
      if (item.kind === 'file' && item.sha256 !== undefined) {
        if (stat.size > 8 * 1024 * 1024) return false;
        const fd = openSync(
          item.path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        try {
          if (!same(surfacePin(fstatSync(fd)), item.pin)) return false;
          const bytes = Buffer.alloc(stat.size);
          let filled = 0;
          while (filled < bytes.length) {
            const got = readSync(fd, bytes, filled, bytes.length - filled, filled);
            if (got === 0) break;
            filled += got;
          }
          if (
            filled !== bytes.length ||
            readSync(fd, Buffer.alloc(1), 0, 1, filled) !== 0 ||
            surfaceHash(bytes) !== item.sha256 ||
            !same(surfacePin(fstatSync(fd)), item.pin)
          )
            return false;
        } finally {
          closeSync(fd);
        }
      }
      if (item.kind === 'directory') {
        if (item.entryCount === undefined || item.entryCount > 100_000) return false;
        const handle = opendirSync(item.path);
        const entries: (string | boolean)[][] = [];
        try {
          for (let i = 0; i < item.entryCount; i += 1) {
            const entry = handle.readSync();
            if (entry === null) return false;
            entries.push([entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink()]);
          }
          if (item.listingComplete === true && handle.readSync() !== null) return false;
          if (surfaceHash(JSON.stringify(entries.sort())) !== item.namesSha256) return false;
        } finally {
          handle.closeSync();
        }
      }
      if (!same(surfacePin(lstatSync(item.path)), item.pin)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
