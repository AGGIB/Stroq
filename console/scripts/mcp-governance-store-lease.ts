import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, rmdir, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { withLock, type LockFs } from '../../packages/core/src/util/lock.ts';
import { exact, uuid, context, workspace } from '../lib/mcp-governance-validation.ts';
import {
  governanceFail as fail,
  owned,
  parseGovernanceMetadata,
} from './mcp-governance-store-schema.ts';
import { directoryIdentity, same, type GovernanceFiles } from './mcp-governance-store-files.ts';

interface Owner {
  schema: 'stroq-mcp-governance-lock/1';
  pid: number;
  host: string;
  token: string;
  operationId: string;
  contextId: string;
  workspaceId: string;
}
function validateOwner(v: unknown): v is Owner {
  return (
    exact(v, ['schema', 'pid', 'host', 'token', 'operationId', 'contextId', 'workspaceId']) &&
    v.schema === 'stroq-mcp-governance-lock/1' &&
    Number.isSafeInteger(v.pid) &&
    v.pid > 0 &&
    v.pid <= 0x7fffffff &&
    typeof v.host === 'string' &&
    v.host.length > 0 &&
    v.host.length <= 255 &&
    !/[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(v.host) &&
    uuid(v.token) &&
    uuid(v.operationId) &&
    context(v.contextId) &&
    workspace(v.workspaceId)
  );
}
export async function inspectGovernanceLock(files: GovernanceFiles, path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o777) !== 0o700)
    fail();
  let count = 0;
  for await (const item of await opendir(path))
    if (++count > 1 || item.name !== 'owner.json' || !item.isFile()) fail();
  if (count !== 1) fail();
  const captured = await files.read(join(path, 'owner.json'), 4096);
  if (!captured.bytes) fail();
  const owner = parseGovernanceMetadata(captured.bytes);
  if (!validateOwner(owner)) fail();
  if (!same(directoryIdentity(stat), directoryIdentity(await lstat(path)))) fail();
  return { owner, captured, directory: directoryIdentity(stat) };
}
function dead(owner: Owner) {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** PID/token custody with exact file/parent checks; only explicit recovery can reap a known dead owner. */
export async function withGovernanceLease<T>(
  files: GovernanceFiles,
  request: {
    operationId: string;
    contextId: string;
    workspaceId: string;
    explicitRecovery: boolean;
  },
  action: (lease: {
    createdHome: Awaited<ReturnType<GovernanceFiles['ensure']>>['createdHome'];
    assertCurrent: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const base = await files.ensure(),
    lock = join(files.directory, '.writer.lock'),
    reaper = lock + '.reaper';
  const directories = new Map<string, unknown>(),
    owners = new Map<string, unknown>(),
    ours = new Set<string>();
  const allowed = (path: string) => path === lock || path === reaper;
  async function directory(path: string) {
    if (!allowed(path)) fail();
    await files.inspect();
    const stat = await lstat(path),
      pin = directoryIdentity(stat);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !owned(stat) ||
      (stat.mode & 0o777) !== 0o700 ||
      (directories.has(path) && !same(directories.get(path), pin))
    )
      fail();
    directories.set(path, pin);
    return stat;
  }
  async function inspect(path: string) {
    await directory(path);
    const read = await inspectGovernanceLock(files, path),
      pin = { file: read.captured.file, sha256: read.captured.sha256 };
    if (owners.has(path) && !same(owners.get(path), pin)) fail();
    owners.set(path, pin);
    await directory(path);
    return read;
  }
  async function writeOwner(path: string, owner: Owner) {
    const h = await open(join(path, 'owner.json'), 'wx', 0o600);
    try {
      await h.writeFile(JSON.stringify(owner));
      await h.sync();
    } finally {
      await h.close();
    }
    ours.add(owner.token);
    await inspect(path);
    await files.sync(path);
  }
  const wrap = (original: { pid: number; host: string; token: string }): Owner => ({
    schema: 'stroq-mcp-governance-lock/1',
    ...original,
    operationId: request.operationId,
    contextId: request.contextId,
    workspaceId: request.workspaceId,
  });
  const fs = {
    async mkdir(path: string) {
      if (!allowed(path)) fail();
      await files.inspect();
      await mkdir(path, { mode: 0o700 });
      directories.delete(path);
      owners.delete(path);
      await directory(path);
      if (path === reaper)
        await writeOwner(path, wrap({ pid: process.pid, host: hostname(), token: randomUUID() }));
    },
    async stat(path: string) {
      return directory(path);
    },
    async readFile(path: string) {
      const dir =
        path === join(lock, 'owner.json')
          ? lock
          : path === join(reaper, 'owner.json')
            ? reaper
            : null;
      if (!dir) fail();
      return (await inspect(dir)).captured.bytes!.toString('utf8');
    },
    async writeFile(path: string, value: string) {
      if (path !== join(lock, 'owner.json')) fail();
      const original = parseGovernanceMetadata(Buffer.from(value));
      if (
        !exact(original, ['pid', 'host', 'token']) ||
        original.pid !== process.pid ||
        original.host !== hostname() ||
        !uuid(original.token)
      )
        fail();
      await directory(lock);
      await writeOwner(lock, wrap(original as any));
    },
    async rm(path: string) {
      const current = await inspect(path);
      if (
        !ours.has(current.owner.token) &&
        (!request.explicitRecovery ||
          !dead(current.owner) ||
          current.owner.contextId !== request.contextId ||
          current.owner.workspaceId !== request.workspaceId)
      )
        fail();
      await directory(path);
      await unlink(join(path, 'owner.json'));
      await rmdir(path);
      await files.sync();
      directories.delete(path);
      owners.delete(path);
    },
  };
  try {
    return await withLock(
      lock,
      async () => {
        const own = await inspect(lock);
        if (!ours.has(own.owner.token)) fail();
        const assertCurrent = async () => {
          const current = await inspect(lock);
          if (!same(current.owner, own.owner)) fail();
        };
        const result = await action({ createdHome: base.createdHome, assertCurrent });
        await assertCurrent();
        return result;
      },
      {
        timeoutMs: 0,
        staleMs: request.explicitRecovery ? 0 : Infinity,
        fs: fs as unknown as LockFs,
      },
    );
  } catch (e) {
    if ((e as Error).message?.startsWith('lock timeout:')) fail('mcp-governance-busy');
    throw e;
  }
}
