import { mkdir, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockFs {
  readonly mkdir: typeof mkdir;
  readonly rm: typeof rm;
  readonly stat: typeof stat;
}

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  /** Test seam: override the fs primitives instead of mocking `node:fs/promises`. */
  readonly fs?: LockFs;
}

const defaultFs: LockFs = { mkdir, rm, stat };

async function isStale(fs: LockFs, lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const info = await fs.stat(lockDir);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function acquire(
  fs: LockFs,
  lockDir: string,
  timeoutMs: number,
  staleMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await isStale(fs, lockDir, staleMs)) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockDir}`);
      await sleep(5 + Math.random() * 10);
    }
  }
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
  await acquire(fs, lockDir, opts.timeoutMs ?? 3000, opts.staleMs ?? 10_000);
  let result: T;
  try {
    result = await fn();
  } catch (fnError) {
    // fn failed: release the lock but never let a release failure hide the real error.
    try {
      await fs.rm(lockDir, { recursive: true, force: true });
    } catch (releaseError) {
      throw withReleaseCause(fnError, releaseError);
    }
    throw fnError;
  }
  // fn succeeded: a release failure here is the only error the caller should see.
  await fs.rm(lockDir, { recursive: true, force: true });
  return result;
}
