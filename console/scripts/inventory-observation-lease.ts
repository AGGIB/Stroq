import type { Stats } from 'node:fs';
import { lstat, mkdir, opendir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  rootIdentity,
  snapshotFile,
  type Identity,
  type FileSnapshot,
} from './inventory-observation-files.ts';
import { runtimeLayout } from './runtime-layout.mjs';

type Owner = { host: string; pid: number; token: string };
export type InventoryObservationLease = {
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
};
function fail(): never {
  throw new Error('monitor-store-unavailable');
}
const owned = (s: Identity) => typeof process.getuid !== 'function' || s.uid === process.getuid();
const identity = (s: Identity) => ({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode });
const privateDirectory = (s: Stats) =>
  s.isDirectory() && !s.isSymbolicLink() && owned(s) && (s.mode & 0o777) === 0o700;
const equal = isDeepStrictEqual;
function safe(capture: FileSnapshot) {
  if (
    capture.directories.some((d) => !owned(d) || (d.mode & 0o777) !== 0o700) ||
    (capture.file &&
      (!owned(capture.file) || capture.file.nlink !== 1 || (capture.file.mode & 0o777) !== 0o600))
  )
    fail();
  return capture;
}
function parseOwner(bytes: Buffer): Owner {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      owner = JSON.parse(text);
    if (
      !owner ||
      Array.isArray(owner) ||
      Object.keys(owner).sort().join(',') !== 'host,pid,token' ||
      JSON.stringify(owner) !== text ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      owner.pid > 0x7fffffff ||
      typeof owner.host !== 'string' ||
      owner.host !== hostname() ||
      /[\uD800-\uDFFF]/u.test(owner.host) ||
      owner.host.length > 255 ||
      typeof owner.token !== 'string' ||
      !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(owner.token)
    )
      fail();
    return owner;
  } catch {
    fail();
  }
}
async function parent(home: string) {
  const root = await rootIdentity(home);
  if (root.path !== home || !privateDirectory(await lstat(home))) fail();
  const directory = join(home, 'console', 'inventory-monitor-leases'),
    guard = join(directory, '.guard');
  const before = safe(await snapshotFile(root, guard, 1024));
  if (before.file || !before.directories.some((d) => d.path === join(home, 'console'))) fail();
  if (!before.directories.some((d) => d.path === directory)) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const after = safe(await snapshotFile(root, guard, 1024));
  if (
    after.file ||
    !before.directories.every((d, index) => equal(d, after.directories[index])) ||
    !after.directories.some((d) => d.path === directory)
  )
    fail();
  async function assertParent() {
    const current = safe(await snapshotFile(root, guard, 1024));
    if (current.file || !equal(current.directories, after.directories)) fail();
  }
  async function boundedNames(next: string | null = null) {
    await assertParent();
    const groups = new Set(),
      names = new Set(),
      listing = await opendir(directory, { bufferSize: 16 });
    let count = 0;
    for await (const item of listing) {
      if (++count > 128 || !/^[a-f0-9]{64}\.lock(?:\.reaper)?$/.test(item.name)) fail();
      groups.add(item.name.slice(0, 64));
      names.add(item.name);
      if (groups.size > 64) fail();
    }
    if (
      next &&
      !names.has(basename(next)) &&
      (count >= 128 || (!groups.has(basename(next).slice(0, 64)) && groups.size >= 64))
    )
      fail();
    await assertParent();
  }
  await boundedNames();
  return { root, directory, assertParent, boundedNames };
}

/** Hold the existing PID/token lock until release, with protected filesystem primitives. */
export async function acquireInventoryMonitorLease({
  home,
  storeId,
}: {
  home: string;
  storeId: string;
}): Promise<InventoryObservationLease | null> {
  if (typeof home !== 'string' || !/^[a-f0-9]{64}$/.test(storeId)) fail();
  try {
    const base = await parent(home),
      lockPath = join(base.directory, `${storeId}.lock`),
      reaper = `${lockPath}.reaper`;
    const directories = new Map<string, Identity>(),
      owners = new Map<string, Pick<FileSnapshot, 'file' | 'sha256'>>();
    const allowed = (path: string) => path === lockPath || path === reaper;
    async function directory(path: string) {
      if (!allowed(path)) fail();
      await base.assertParent();
      const stat = await lstat(path);
      if (
        !privateDirectory(stat) ||
        (directories.has(path) && !equal(directories.get(path), identity(stat)))
      )
        fail();
      directories.set(path, identity(stat));
      return stat;
    }
    async function inspect(path: string) {
      await directory(path);
      const listing = await opendir(path, { bufferSize: 2 });
      let count = 0;
      for await (const item of listing) if (++count > 1 || item.name !== 'owner.json') fail();
      const captured = safe(await snapshotFile(base.root, join(path, 'owner.json'), 1024));
      await directory(path);
      if (captured.bytes === null) {
        if (owners.has(path)) fail();
        return null;
      }
      const parsed = parseOwner(captured.bytes);
      const pinned = { file: captured.file, sha256: captured.sha256 };
      if (owners.has(path) && !equal(owners.get(path), pinned)) fail();
      owners.set(path, pinned);
      return { parsed, captured };
    }
    async function inspectIfPresent(path: string) {
      try {
        return await inspect(path);
      } catch (error: any) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    }
    await inspectIfPresent(lockPath);
    const fs = {
      async mkdir(path: string) {
        if (!allowed(path)) fail();
        await base.assertParent();
        await base.boundedNames(path);
        await mkdir(path, { mode: 0o700 });
        directories.delete(path);
        owners.delete(path);
        await directory(path);
      },
      stat: directory,
      async readFile(path: string, encoding: BufferEncoding) {
        const lock =
          path === join(lockPath, 'owner.json')
            ? lockPath
            : path === join(reaper, 'owner.json')
              ? reaper
              : null;
        if (!lock) fail();
        const state = await inspect(lock);
        if (!state) {
          const error: NodeJS.ErrnoException = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        if (state.captured.bytes === null) fail();
        return state.captured.bytes.toString(encoding);
      },
      async writeFile(path: string, value: string) {
        const lock =
          path === join(lockPath, 'owner.json')
            ? lockPath
            : path === join(reaper, 'owner.json')
              ? reaper
              : null;
        if (!lock) fail();
        await directory(lock);
        const bytes = Buffer.from(value);
        if (bytes.length > 1024) fail();
        parseOwner(bytes);
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
        await inspect(lock);
      },
      async rm(path: string, options: Parameters<typeof rm>[1]) {
        await inspect(path);
        await base.assertParent();
        await rm(path, options);
        directories.delete(path);
        owners.delete(path);
      },
    };
    const { withLock } = await import(pathToFileURL(runtimeLayout().core).href);
    if (typeof withLock !== 'function') fail();
    let resolveAcquired!: (value: InventoryObservationLease | null) => void;
    let rejectAcquired!: (reason: unknown) => void;
    let resume!: () => void;
    let acquired = false,
      released = false;
    const ready = new Promise<InventoryObservationLease | null>((resolve, reject) => {
      resolveAcquired = resolve;
      rejectAcquired = reject;
    });
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const task: Promise<void> = withLock(
      lockPath,
      async () => {
        const own = await inspect(lockPath);
        if (!own) fail();
        acquired = true;
        const assertCurrent = async () => {
          try {
            const current = await inspect(lockPath);
            if (!current || !equal(current.parsed, own.parsed)) fail();
          } catch {
            fail();
          }
        };
        resolveAcquired({
          assertCurrent,
          async release() {
            if (!released) {
              released = true;
              resume();
            }
            try {
              await task;
            } catch {
              fail();
            }
          },
        });
        await held;
      },
      { timeoutMs: 100, staleMs: 10000, fs },
    );
    task.catch(async (error: any) => {
      if (acquired) return;
      if (error?.message?.startsWith('lock timeout:')) {
        try {
          await inspectIfPresent(lockPath);
          resolveAcquired(null);
        } catch {
          rejectAcquired(new Error('monitor-store-unavailable'));
        }
      } else rejectAcquired(new Error('monitor-store-unavailable'));
    });
    return await ready;
  } catch {
    fail();
  }
}
