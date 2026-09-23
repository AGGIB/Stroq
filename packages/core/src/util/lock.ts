import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockFs {
  readonly mkdir: typeof mkdir;
  readonly rm: typeof rm;
  readonly stat: typeof stat;
  readonly readFile?: typeof readFile;
  readonly writeFile?: typeof writeFile;
}

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /** Test seam: override the fs primitives instead of mocking `node:fs/promises`. */
  readonly fs?: LockFs;
}

const defaultFs: LockFs = { mkdir, rm, stat, readFile, writeFile };

interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly token: string;
}

const ownerFile = (lockDir: string): string => join(lockDir, 'owner.json');

async function readOwner(fs: LockFs, lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await (fs.readFile ?? readFile)(ownerFile(lockDir), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return null;
    const owner = value as Partial<LockOwner>;
    return typeof owner.pid === 'number' &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.host === 'string' &&
      typeof owner.token === 'string'
      ? (owner as LockOwner)
      : null;
  } catch {
    return null;
  }
}

function ownerAlive(owner: LockOwner): boolean {
  if (owner.host !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function isStale(fs: LockFs, lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const info = await fs.stat(lockDir);
    if (Date.now() - info.mtimeMs <= staleMs) return false;
    const owner = await readOwner(fs, lockDir);
    return owner === null || !ownerAlive(owner);
  } catch {
    return false;
  }
}

async function acquire(
  fs: LockFs,
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
): Promise<LockOwner> {
  const deadline = Date.now() + timeoutMs;
  const owner: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID() };
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      try {
        await (fs.writeFile ?? writeFile)(ownerFile(lockDir), JSON.stringify(owner), {
          mode: 0o600,
        });
      } catch (err) {
        await fs.rm(lockDir, { recursive: true, force: true });
        throw err;
      }
      return owner;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await isStale(fs, lockDir, staleMs)) {
        // Only one contender may reclaim an orphan. Without this gate another
        // contender could remove a newly acquired lock after the first reaper.
        const reaper = `${lockDir}.reaper`;
        try {
          await fs.mkdir(reaper);
        } catch (reaperError) {
          if ((reaperError as NodeJS.ErrnoException).code !== 'EEXIST') throw reaperError;
          if (await isStale(fs, reaper, Math.max(staleMs, 60_000))) {
            await fs.rm(reaper, { recursive: true, force: true });
            continue;
          }
          // Another contender is reaping, or died while it was. Wait like any other
          // contended lock: going straight back to the top of the loop spun without a
          // deadline until the reaper aged out, 60 s, far past the hook's own timeout.
          if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockDir}`);
          await sleep(5 + Math.random() * 10);
          continue;
        }
        try {
          if (await isStale(fs, lockDir, staleMs))
            await fs.rm(lockDir, { recursive: true, force: true });
        } finally {
          await fs.rm(reaper, { recursive: true, force: true });
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockDir}`);
      await sleep(5 + Math.random() * 10);
    }
  }
}

async function release(fs: LockFs, lockDir: string, owner: LockOwner): Promise<void> {
  if ((await readOwner(fs, lockDir))?.token !== owner.token)
    throw new Error(`lock ownership lost: ${lockDir}`);
  await fs.rm(lockDir, { recursive: true, force: true });
}

function withReleaseCause(fnError: unknown, releaseError: unknown): unknown {
  if (fnError instanceof Error && fnError.cause === undefined) {
    Object.assign(fnError, { cause: releaseError });
  }
  return fnError;
}

export async function withLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const fs = opts.fs ?? defaultFs;
  const owner = await acquire(fs, lockDir, opts.timeoutMs ?? 3000, opts.staleMs ?? 10_000);
  let result: T;
  try {
    result = await fn();
  } catch (fnError) {
    // fn failed: release the lock but never let a release failure hide the real error.
    try {
      await release(fs, lockDir, owner);
    } catch (releaseError) {
      throw withReleaseCause(fnError, releaseError);
    }
    throw fnError;
  }
  // fn succeeded: a release failure here is the only error the caller should see.
  await release(fs, lockDir, owner);
  return result;
}
