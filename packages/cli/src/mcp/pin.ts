import { readRegularFile } from '@stroq/core';
import { lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { McpPinSchema, readPassportLock } from '../install/lock-reader.js';
import { readDirTree, READ_DIR_BLIND_SPOTS } from '../install/read-dir.js';
import { buildTree, treeDigest } from '../install/tree.js';
import type { Tree, TreeEntry } from '../install/types.js';
import { passportsFileIn, runDirIn, storeDirIn, stroqHome } from '../paths.js';
import { MCP_PIN } from './pin-argument.js';

export interface PinOptions {
  readonly server: string;
  readonly pin: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly home?: string;
}
export interface PinnedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cleanup: () => Promise<void>;
}

function jsonFile(file: string): unknown {
  if (lstatSync(file).isSymbolicLink()) throw new Error('cannot verify a linked pin record');
  const read = readRegularFile(file, 4 * 1024 * 1024, { noFollow: true });
  if (read.kind !== 'text') throw new Error('cannot verify a bounded regular pin record');
  return JSON.parse(read.text) as unknown;
}

function confirm(options: PinOptions, home: string): string {
  if (!MCP_PIN.test(options.pin))
    throw new Error('invalid pin: expected sha256:<64 lowercase hex>');
  let lock;
  try {
    lock = readPassportLock(passportsFileIn(home));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'the local confirmation lock exceeds the size limit'
    )
      throw error;
    throw new Error('the local MCP confirmation lock is missing or invalid');
  }
  // Own-property lookup: a server called __proto__ never selects an inherited object.
  const raw = Object.hasOwn(lock.mcp, options.server) ? lock.mcp[options.server] : undefined;
  const record = McpPinSchema.safeParse(raw);
  const digest = options.pin.slice(7);
  if (!record.success || record.data.digest !== digest || record.data.grant.pin !== options.pin)
    throw new Error('this server and digest are not confirmed on this machine');
  return digest;
}

async function plainFolder(folder: string): Promise<void> {
  const stat = await lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('cannot verify a linked store folder');
}

/** Read store bytes once. Both the digest and the private copy use these owned buffers. */
async function verifiedTree(home: string, digest: string): Promise<{ tree: Tree; root: string }> {
  const store = join(storeDirIn(home), `sha256-${digest.slice(0, 32)}`);
  await plainFolder(storeDirIn(home));
  await plainFolder(store);
  const root = join(store, 'tree');
  await plainFolder(root);
  const manifest = jsonFile(join(store, 'manifest.json')) as Tree;
  // buildTree checks every untrusted metadata field, path, size, hash and collision.
  const metadata = buildTree(manifest.entries);
  if (metadata.entries.some((entry) => entry.kind !== 'file') || treeDigest(metadata) !== digest)
    throw new Error('the stored manifest digest changed');
  const read = await readDirTree(root);
  if (read.blindSpots.some((spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit))
    throw new Error('cannot verify all files of the pinned tree');
  const flags = new Map(metadata.entries.map((entry) => [entry.path, entry.exec]));
  const tree = buildTree(
    read.tree.entries.map((entry) => ({ ...entry, exec: flags.get(entry.path) ?? false })),
    { complete: true },
  );
  if (tree.entries.some((entry) => entry.kind !== 'file') || treeDigest(tree) !== digest)
    throw new Error('the pinned server files changed (digest mismatch)');
  return { tree, root };
}

function entrypoint(options: PinOptions, root: string, tree: Tree): string {
  if (options.command !== 'node' && options.command !== process.execPath)
    throw new Error('a runtime pin supports only a node server');
  const first = options.args[0];
  if (first === undefined || !isAbsolute(first))
    throw new Error('a pinned entrypoint must be an absolute file in the store');
  const rel = relative(root, first).split(sep).join('/');
  if (!tree.entries.some((entry) => entry.path === rel))
    throw new Error('the pinned entrypoint is not a file in the confirmed tree');
  return rel;
}

function treeArgument(arg: string, root: string, tree: Tree): string | null {
  const rel = isAbsolute(arg) ? relative(root, arg) : null;
  if (rel !== null && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    const path = rel.split(sep).join('/');
    if (
      path === '' ||
      tree.entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))
    )
      return path;
    throw new Error('a pinned argument does not name a confirmed tree file or directory');
  }
  // Embedded references cannot safely be rewritten: argv is not a known syntax.
  const normalized = arg.replaceAll('\\', '/');
  const storeRoot = root.replaceAll('\\', '/');
  if (
    (process.platform === 'win32' ? normalized.toLowerCase() : normalized).includes(
      process.platform === 'win32' ? storeRoot.toLowerCase() : storeRoot,
    )
  )
    throw new Error('a pinned argument contains an embedded store tree reference');
  return null;
}

async function checked(
  options: PinOptions,
): Promise<{ tree: Tree; args: readonly (string | null)[]; home: string }> {
  const home = options.home ?? stroqHome();
  const digest = confirm(options, home);
  const { tree, root } = await verifiedTree(home, digest);
  entrypoint(options, root, tree);
  return { tree, args: options.args.map((arg) => treeArgument(arg, root, tree)), home };
}

async function privateRunDir(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await plainFolder(home);
  const run = runDirIn(home);
  await mkdir(run, { recursive: true, mode: 0o700 });
  await plainFolder(run);
  for (const folder of [home, run]) {
    const info = await lstat(folder);
    if (process.getuid !== undefined && info.uid !== process.getuid())
      throw new Error('cannot use a runtime folder owned by another user');
    await chmod(folder, 0o700);
  }
  return run;
}

async function copyEntry(folder: string, entry: TreeEntry): Promise<void> {
  const target = join(folder, ...entry.path.split('/'));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, entry.bytes!, { flag: 'wx', mode: entry.exec ? 0o700 : 0o600 });
}

/** The verified code is never started from a mutable store path. */
export async function preparePin(options: PinOptions): Promise<PinnedLaunch> {
  const { tree, args, home } = await checked(options);
  const folder = await mkdtemp(join(await privateRunDir(home), 'stroq-mcp-pin-'));
  const cleanup = async (): Promise<void> => {
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
  try {
    for (const file of tree.entries) await copyEntry(folder, file);
    return {
      command: process.execPath,
      args: options.args.map((arg, i) =>
        args[i] === null ? arg : join(folder, ...args[i]!.split('/')),
      ),
      cwd: folder,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

/** Offline diagnostics share the runtime verification, without spawning or copying code. */
export async function inspectPin(
  options: PinOptions,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  try {
    await checked(options);
    return { ok: true, detail: 'confirmed bytes intact (tamper-evident, not tamper-proof)' };
  } catch {
    return {
      ok: false,
      detail:
        'pinned MCP server drifted or cannot be verified; start refused (tamper-evident, not tamper-proof)',
    };
  }
}
