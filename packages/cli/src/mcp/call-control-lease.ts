import { constants, type BigIntStats } from 'node:fs';
import { mkdir, open, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { callControlError, callControlUuid } from './call-control-types.js';
import type { CallControlFile, CallControlContext } from './call-control-files.js';

const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
export interface CallControlLease {
  assertCurrentSync(): void;
  assertCurrent(): Promise<void>;
}
interface LeaseSecurity {
  contextSync(home: string): CallControlContext | null;
  context(home: string, create: boolean): Promise<CallControlContext | null>;
  privateDir(path: string): BigIntStats;
  readSafeFileSync(file: string, maxBytes: number): CallControlFile | null;
  dirPin(stat: BigIntStats): string;
  callControlFileError(error: unknown): never;
}
/** Share the file authority's checks without a runtime module cycle or a second security reader. */
export function createCallControlLeaseRunner(security: LeaseSecurity) {
  const { contextSync, context, privateDir, readSafeFileSync, dirPin, callControlFileError } =
    security;
  interface Owner {
    readonly pid: number;
    readonly host: string;
    readonly token: string;
  }
  function owner(file: CallControlFile | null): Owner | null {
    if (!file) return null;
    try {
      const value: unknown = JSON.parse(file.bytes.toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      const v = value as Record<string, unknown>;
      if (
        Object.keys(v).length !== 3 ||
        !Number.isSafeInteger(v.pid) ||
        Number(v.pid) <= 0 ||
        typeof v.host !== 'string' ||
        v.host.length > 255 ||
        !callControlUuid(v.token) ||
        JSON.stringify({ pid: v.pid, host: v.host, token: v.token }) !== file.bytes.toString('utf8')
      )
        return null;
      return v as unknown as Owner;
    } catch {
      return null;
    }
  }
  function dead(o: Owner | null): boolean {
    if (!o || o.host !== hostname()) return false;
    try {
      process.kill(o.pid, 0);
      return false;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  async function recoverOrphan(c: CallControlContext): Promise<void> {
    const lock = join(c.directory, '.lock');
    const gate = join(c.directory, '.reaper');
    let gatePin: string | null = null;
    try {
      const before = dirPin(privateDir(lock));
      const file = readSafeFileSync(join(lock, 'owner.json'), 4096);
      if (!dead(owner(file))) return;
      try {
        await mkdir(gate, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return;
        throw e;
      }
      gatePin = dirPin(privateDir(gate));
      if (contextSync(c.home)?.identity !== c.identity || dirPin(privateDir(lock)) !== before)
        return;
      const current = readSafeFileSync(join(lock, 'owner.json'), 4096);
      if (!current || current.pin !== file?.pin || !dead(owner(current))) return;
      // Remove only this pinned known owner and empty directory, never recursively.
      await unlink(join(lock, 'owner.json'));
      if (dirPin(privateDir(lock)) === before) await rmdir(lock);
    } catch (e) {
      if (!missing(e)) throw e;
    } finally {
      if (gatePin !== null && dirPin(privateDir(gate)) === gatePin) await rmdir(gate);
    }
  }
  return async function withCallControlLease<T>(
    home: string,
    create: boolean,
    callback: (lease: CallControlLease) => Promise<T>,
    timeoutMs = 1000,
  ): Promise<T> {
    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000)
        callControlError('mcp-call-control-invalid');
      const c = await context(home, create);
      if (!c) return callControlError('mcp-call-control-unavailable');
      const lock = join(c.directory, '.lock');
      const ownerPath = join(lock, 'owner.json');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const currentContext = contextSync(home);
        if (currentContext?.identity !== c.identity || currentContext.home !== c.home)
          callControlError('mcp-call-control-unavailable');
        try {
          await mkdir(lock, { mode: 0o700 });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        privateDir(lock);
        await recoverOrphan(c);
        if (Date.now() >= deadline) callControlError('mcp-call-control-busy');
        await sleep(5);
      }
      const lockPin = dirPin(privateDir(lock));
      const o: Owner = { pid: process.pid, host: hostname(), token: randomUUID() };
      const handle = await open(
        ownerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(JSON.stringify(o));
        await handle.sync();
      } finally {
        await handle.close();
      }
      const ownerFile = readSafeFileSync(ownerPath, 4096);
      if (!ownerFile || owner(ownerFile)?.token !== o.token)
        callControlError('mcp-call-control-unavailable');
      const assertCurrentSync = (): void => {
        try {
          const currentContext = contextSync(home);
          if (
            currentContext?.identity !== c.identity ||
            currentContext.home !== c.home ||
            dirPin(privateDir(lock)) !== lockPin
          )
            callControlError('mcp-call-control-unavailable');
          const current = readSafeFileSync(ownerPath, 4096);
          if (!current || current.pin !== ownerFile.pin || !current.bytes.equals(ownerFile.bytes))
            callControlError('mcp-call-control-unavailable');
        } catch (e) {
          callControlFileError(e);
        }
      };
      const lease: CallControlLease = {
        assertCurrentSync,
        assertCurrent: async () => assertCurrentSync(),
      };
      let result: T;
      try {
        assertCurrentSync();
        result = await callback(lease);
      } catch (e) {
        try {
          assertCurrentSync();
          await unlink(ownerPath);
          if (dirPin(privateDir(lock)) === lockPin) await rmdir(lock);
        } catch {
          /* Preserve the operation's first failure. */
        }
        throw e;
      }
      assertCurrentSync();
      await unlink(ownerPath);
      if (dirPin(privateDir(lock)) !== lockPin) callControlError('mcp-call-control-unavailable');
      await rmdir(lock);
      return result;
    } catch (e) {
      return callControlFileError(e);
    }
  };
}
