import { mkdir, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
}

async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

async function acquire(lockDir: string, timeoutMs: number, staleMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await isStale(lockDir, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`lock timeout: ${lockDir}`);
      await sleep(5 + Math.random() * 10);
    }
  }
}

export async function withLock<T>(
  lockDir: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  await acquire(lockDir, opts.timeoutMs ?? 3000, opts.staleMs ?? 10_000);
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}
