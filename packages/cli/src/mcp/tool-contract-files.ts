import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  realpath,
  mkdir,
  open,
  rename,
  unlink,
  readdir,
  rm,
  stat,
  type readFile,
  type writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, parse } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withLock } from '@stroq/core';
import {
  contractError,
  TOOL_CONTRACT_ERRORS,
  TOOL_CONTRACT_LIMITS as LIMIT,
} from './tool-contract-types.js';
import { rawContractSha } from './tool-contract-canonical.js';

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
export interface ContractFile {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly pin: string;
}
const pin = (s: BigIntStats): string =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const owned = (s: BigIntStats): boolean =>
  process.getuid === undefined || s.uid === BigInt(process.getuid());
function safeDir(s: BigIntStats, privateMode: boolean): boolean {
  return (
    s.isDirectory() &&
    !s.isSymbolicLink() &&
    (!privateMode || (owned(s) && (s.mode & 0o077n) === 0n))
  );
}

/** Resolve a missing fixed home from its nearest canonical ancestor, without creating it. */
export async function canonicalContractPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!missing(error)) return contractError('tool-contract-unavailable');
  }
  const parent = dirname(absolute);
  if (parent === absolute) return contractError('tool-contract-unavailable');
  return join(await canonicalContractPath(parent), absolute.slice(parent.length + 1));
}

/** No symlink traversal is accepted after the server-selected path has been canonicalized. */
async function proveAncestors(path: string): Promise<void> {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      if (!safeDir(await lstat(current, { bigint: true }), false))
        contractError('tool-contract-unavailable');
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
  }
}

export async function contractDirectory(home: string, create: boolean): Promise<string | null> {
  if (process.platform === 'win32') contractError('tool-contract-unsupported');
  await proveAncestors(home);
  for (const path of [home, join(home, 'store'), join(home, 'store', 'mcp-contracts')]) {
    let stat: BigIntStats;
    try {
      stat = await lstat(path, { bigint: true });
    } catch (e) {
      if (!missing(e)) throw e;
      if (!create) return null;
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (made) {
        if ((made as NodeJS.ErrnoException).code !== 'EEXIST') throw made;
      }
      stat = await lstat(path, { bigint: true });
    }
    if (!safeDir(stat, true)) contractError('tool-contract-unavailable');
  }
  const directory = join(home, 'store', 'mcp-contracts');
  if ((await realpath(directory)) !== directory) contractError('tool-contract-unavailable');
  return directory;
}

export async function contractDirectoryIdentity(home: string): Promise<string> {
  const directory = await contractDirectory(home, false);
  if (directory === null) contractError('tool-contract-stale');
  const identity = [];
  for (const path of [home, join(home, 'store'), directory]) {
    const s = await lstat(path, { bigint: true });
    if (!safeDir(s, true)) contractError('tool-contract-unavailable');
    identity.push([s.dev, s.ino, s.mode, s.uid, s.gid].join(':'));
  }
  return identity.join('/');
}

export async function readContractFile(
  file: string,
  maxBytes: number = LIMIT.recordBytes,
): Promise<ContractFile | null> {
  let before: BigIntStats;
  try {
    before = await lstat(file, { bigint: true });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !owned(before) ||
    before.nlink !== 1n ||
    (before.mode & 0o077n) !== 0n ||
    before.size > BigInt(maxBytes)
  )
    contractError(
      before.size > BigInt(maxBytes) ? 'tool-contract-limit' : 'tool-contract-unavailable',
    );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (pin(opened) !== pin(before)) contractError('tool-contract-stale');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) contractError('tool-contract-stale');
      offset += read.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0)
      contractError('tool-contract-stale');
    if (
      pin(await handle.stat({ bigint: true })) !== pin(opened) ||
      pin(await lstat(file, { bigint: true })) !== pin(opened)
    )
      contractError('tool-contract-stale');
    return { bytes, sha256: rawContractSha(bytes), pin: pin(opened) };
  } finally {
    await handle.close();
  }
}

export async function contractFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > LIMIT.bindings + 1) contractError('tool-contract-limit');
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.lock' && entry.isDirectory()) continue;
    if (!/^binding-[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile())
      contractError('tool-contract-unavailable');
    files.push(entry.name);
  }
  if (files.length > LIMIT.bindings) contractError('tool-contract-limit');
  return files.sort();
}

export async function writeContractFile(
  home: string,
  file: string,
  bytes: Buffer,
  before: ContractFile | null,
  beforeCommit?: () => Promise<void>,
): Promise<ContractFile> {
  if (bytes.length > LIMIT.recordBytes) contractError('tool-contract-limit');
  const directory = dirname(file);
  const originalDirectory = await lstat(directory, { bigint: true });
  const temp = join(directory, '.stage-' + randomUUID());
  let committed = false;
  try {
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await readContractFile(temp);
    if (!staged || !staged.bytes.equals(bytes)) contractError('tool-contract-write-unconfirmed');
    await contractDirectory(home, false);
    const now = await lstat(directory, { bigint: true });
    if (now.dev !== originalDirectory.dev || now.ino !== originalDirectory.ino)
      contractError('tool-contract-stale');
    const current = await readContractFile(file);
    if (
      (current?.pin ?? null) !== (before?.pin ?? null) ||
      (current?.sha256 ?? null) !== (before?.sha256 ?? null)
    )
      contractError('tool-contract-stale');
    await beforeCommit?.();
    await rename(temp, file);
    committed = true;
    const dir = await open(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
    const after = await readContractFile(file);
    if (!after || !after.bytes.equals(bytes)) contractError('tool-contract-write-unconfirmed');
    return after;
  } catch (e) {
    if (committed) contractError('tool-contract-write-unconfirmed');
    throw e;
  } finally {
    if (!committed) await unlink(temp).catch(() => {});
  }
}

export async function contractLock<T>(
  home: string,
  create: boolean,
  fn: (directory: string) => Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  const directory = await contractDirectory(home, create);
  if (directory === null) return null;
  const root = await lstat(directory, { bigint: true });
  const lock = join(directory, '.lock');
  try {
    try {
      const s = await lstat(lock, { bigint: true });
      if (!safeDir(s, false) || !owned(s)) contractError('tool-contract-unavailable');
    } catch (e) {
      if (!missing(e)) throw e;
    }
    // The generic lock accepts fs seams: constrain its owner record as strictly as the authority files.
    const readOwner = (async (path: string, encoding?: string) => {
      const found = await readContractFile(path, 4096);
      if (!found) {
        const error = new Error('missing');
        Object.assign(error, { code: 'ENOENT' });
        throw error;
      }
      return encoding === 'utf8' ? found.bytes.toString('utf8') : found.bytes;
    }) as unknown as typeof readFile;
    const writeOwner = (async (path: string, data: string) => {
      if (Buffer.byteLength(data) > 4096) contractError('tool-contract-limit');
      const handle = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }) as unknown as typeof writeFile;
    return await withLock(
      lock,
      async () => {
        await contractDirectory(home, false);
        const current = await lstat(directory, { bigint: true });
        if (root.dev !== current.dev || root.ino !== current.ino)
          contractError('tool-contract-stale');
        return fn(directory);
      },
      {
        timeoutMs,
        staleMs: 10_000,
        fs: {
          mkdir: (async (path) => mkdir(path, { mode: 0o700 })) as typeof mkdir,
          rm,
          stat,
          readFile: readOwner,
          writeFile: writeOwner,
        },
      },
    );
  } catch (e) {
    if (e instanceof Error && TOOL_CONTRACT_ERRORS.some((code) => code === e.message)) throw e;
    if (e instanceof Error && e.message.startsWith('lock timeout:'))
      contractError('tool-contract-lock-timeout');
    return contractError('tool-contract-unavailable');
  }
}
