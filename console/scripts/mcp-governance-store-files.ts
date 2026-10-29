import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import {
  governanceFail as fail,
  owned,
  GOVERNANCE_RECORD_BYTES,
} from './mcp-governance-store-schema.ts';
import type { GovernanceRootPin } from './mcp-governance-store-types.ts';

export const same = isDeepStrictEqual;
export const directoryIdentity = (s: any) => ({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode });
export const withoutPaths = (snapshot: any, home?: string) =>
  snapshot.directories
    .filter((d: any) => home === undefined || d.path === home || d.path.startsWith(home + '/'))
    .map(directoryIdentity);
export const fileRevision = (snapshot: any, home?: string) => ({
  sha256: snapshot.sha256,
  file: snapshot.file,
  parents: withoutPaths(snapshot, home),
});
export function createGovernanceFiles(home: string) {
  if (typeof home !== 'string' || resolve(home) !== home || home.length > 4096)
    fail('mcp-governance-invalid');
  const directory = join(home, 'mcp-governance');
  let anchor: GovernanceRootPin | null = null,
    homePin: GovernanceRootPin | null = null,
    storePin: GovernanceRootPin | null = null;
  async function inspect() {
    let at = home;
    while (!anchor) {
      try {
        const root = await rootIdentity(at);
        if (root.path !== at || !owned(root) || (root.mode & 0o022) !== 0) fail();
        anchor = root;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw error;
        at = dirname(at);
      }
    }
    const captured = await snapshotFile(anchor, join(directory, '.guard'), 0);
    if (
      captured.file ||
      captured.directories.some(
        (d: any) =>
          !owned(d) ||
          (d.mode & 0o022) !== 0 ||
          (d.path === directory && (d.mode & 0o777) !== 0o700),
      )
    )
      fail();
    const currentHome = captured.directories.find((d: any) => d.path === home) ?? null;
    const currentStore = captured.directories.find((d: any) => d.path === directory) ?? null;
    if ((homePin && !same(homePin, currentHome)) || (storePin && !same(storePin, currentStore)))
      fail();
    homePin ??= currentHome;
    storePin ??= currentStore;
    return { root: anchor, home: currentHome, store: currentStore, captured };
  }
  async function ensure() {
    const before = await inspect();
    let createdHome: GovernanceRootPin | null = null;
    const missing: string[] = [];
    for (
      let at = directory;
      !before.captured.directories.some((d: any) => d.path === at);
      at = dirname(at)
    ) {
      missing.unshift(at);
    }
    for (const path of missing) {
      await inspect();
      let made = false;
      try {
        await mkdir(path, { mode: 0o700 });
        made = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !owned(info) ||
        (info.mode & 0o777) !== 0o700 ||
        (await realpath(path)) !== path
      )
        fail();
      if (made && path === home) createdHome = { path, ...directoryIdentity(info) };
      await sync(dirname(path));
      await inspect();
    }
    return { ...(await inspect()), createdHome };
  }
  async function read(path: string, max = GOVERNANCE_RECORD_BYTES) {
    const loc = await inspect(),
      snapshot = await snapshotFile(loc.root, path, max);
    if (
      snapshot.file &&
      (!owned(snapshot.file) || snapshot.file.nlink !== 1 || (snapshot.file.mode & 0o777) !== 0o600)
    )
      fail();
    if (
      snapshot.directories.some(
        (d: any) =>
          !owned(d) ||
          (d.mode & 0o022) !== 0 ||
          (d.path.startsWith(directory) && (d.mode & 0o777) !== 0o700),
      )
    )
      fail();
    return snapshot;
  }
  async function sync(path = directory) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await handle.sync();
    } catch (e) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((e as NodeJS.ErrnoException).code ?? ''))
        throw e;
    } finally {
      await handle.close();
    }
  }
  return { home, directory, inspect, ensure, read, sync };
}
export type GovernanceFiles = ReturnType<typeof createGovernanceFiles>;
