import { mkdir, mkdtemp, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { readRegularFile } from '@stroq/core';
import { assertWriteAllowed } from '../harden/atomic.js';
import { storeDirIn } from '../paths.js';
import { readDirTree, READ_DIR_BLIND_SPOTS } from './read-dir.js';
import { buildTree, treeDigest } from './tree.js';
import type { Tree, TreeEntry } from './types.js';

export function storePath(home: string, digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('invalid store digest');
  return join(storeDirIn(home), `sha256-${digest.slice(0, 32)}`);
}

/** A directory link is never a tree to replace or remove, even when --force was given. */
export async function assertPlainDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('refusing a linked skill or store directory');
    if (!stat.isDirectory())
      throw new Error('the skill or store path exists and is not a directory');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Never materialise links or nested repositories; a silent omission would change the inspected tree. */
export function assertWritableTree(tree: Tree, digest: string): void {
  if (treeDigest(tree) !== digest) throw new Error('the inspected bytes changed before writing');
  if (tree.entries.some((entry) => entry.kind !== 'file' || entry.bytes === undefined))
    throw new Error('a skill with links, nested repositories or missing bytes cannot be installed');
}

/** Explicit platform input keeps the Windows refusal covered on every test runner. */
export function assertInstallablePlatform(tree: Tree, platform: NodeJS.Platform): void {
  if (platform === 'win32' && tree.entries.some((entry) => entry.exec))
    throw new Error(
      'Windows cannot preserve executable bits in an installed skill; use Linux or macOS for this archive',
    );
}

export async function writeTree(
  tree: Tree,
  folder: string,
  digest: string,
  store = false,
): Promise<void> {
  assertWritableTree(tree, digest);
  for (const entry of tree.entries) {
    const target = resolve(folder, entry.path);
    assertWriteAllowed(target, { root: folder, initRule: false });
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, entry.bytes!, {
      flag: 'wx',
      mode: !store && entry.exec ? 0o700 : 0o600,
    });
  }
  if (!store) {
    const { tree: written } = await readDirTree(folder);
    if (treeDigest(written) !== digest)
      throw new Error('the installed bytes did not preserve the inspected digest');
  }
}

export async function readStoredTree(folder: string, digest: string): Promise<Tree> {
  if (!(await assertPlainDirectory(folder))) throw new Error('the stored tree is missing');
  const manifest = readRegularFile(join(folder, 'manifest.json'), 4 * 1024 * 1024);
  if (manifest.kind !== 'text') throw new Error('the store manifest is not a bounded regular file');
  let meta: Tree;
  try {
    const raw: unknown = JSON.parse(manifest.text);
    if (raw === null || typeof raw !== 'object' || Object.keys(raw).join() !== 'entries')
      throw new Error();
    meta = buildTree((raw as Tree).entries);
    if (treeDigest(meta) !== digest) throw new Error();
  } catch {
    throw new Error('the store manifest does not match the confirmed digest');
  }
  const files = join(folder, 'tree');
  if (!(await assertPlainDirectory(files))) throw new Error('the stored files are missing');
  const { tree, blindSpots } = await readDirTree(files);
  if (blindSpots.some((spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit))
    throw new Error('the stored tree contains files that cannot be verified');
  if (tree.entries.length !== meta.entries.length) throw new Error('the stored files changed');
  const entries = meta.entries.map((entry, index): TreeEntry => {
    const disk = tree.entries[index];
    if (disk?.path !== entry.path || disk.kind !== 'file' || disk.bytes === undefined)
      throw new Error('the stored paths changed');
    return { ...entry, bytes: disk.bytes };
  });
  const verified = buildTree(entries, { complete: true });
  assertWritableTree(verified, digest);
  return verified;
}

export async function putStore(home: string, tree: Tree, digest: string): Promise<string> {
  assertWritableTree(tree, digest);
  const target = storePath(home, digest);
  assertWriteAllowed(target, { root: home, initRule: false });
  if (await assertPlainDirectory(target)) {
    await readStoredTree(target, digest);
    return target;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(target), '.stage-'));
  try {
    const files = join(stage, 'tree');
    await mkdir(files, { mode: 0o700 });
    await writeTree(tree, files, digest, true);
    const entries = tree.entries.map(({ bytes: _bytes, ...entry }) => entry);
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify({ entries })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    await readStoredTree(stage, digest);
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return target;
}
