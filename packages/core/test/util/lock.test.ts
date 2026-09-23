import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit-log.js';
import { withLock } from '../../src/util/lock.js';

describe('withLock', () => {
  it('keeps separate processes out of a long critical section', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-lock-processes-'));
    const lock = join(dir, 'shared.lock');
    const trace = join(dir, 'trace');
    const auditFile = join(dir, 'audit.jsonl');
    const moduleUrl = pathToFileURL(join(import.meta.dirname, '../../src/util/lock.ts')).href;
    const auditUrl = pathToFileURL(join(import.meta.dirname, '../../src/audit/audit-log.ts')).href;
    const worker = `
      import { appendFileSync } from 'node:fs';
      import { withLock } from ${JSON.stringify(moduleUrl)};
      import { AuditLog } from ${JSON.stringify(auditUrl)};
      await withLock(process.argv[1], async () => {
        appendFileSync(process.argv[2], 'enter\\n');
        await new Promise(resolve => setTimeout(resolve, 700));
        appendFileSync(process.argv[2], 'exit\\n');
      }, { staleMs: 30, timeoutMs: 5000 });
      await new AuditLog(process.argv[3]).append({ sessionId: 's', phase: 'pre', tool: 'Bash', summary: 'synthetic', classes: [] });
    `;
    const run = () =>
      promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        worker,
        lock,
        trace,
        auditFile,
      ]);
    const first = run();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        if (readFileSync(trace, 'utf8').includes('enter')) break;
      } catch {
        /* the first child has not entered yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(readFileSync(trace, 'utf8')).toContain('enter');
    const second = run();
    await Promise.all([first, second]);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      'enter',
      'exit',
      'enter',
      'exit',
    ]);
    const audit = new AuditLog(auditFile);
    expect(await audit.readAll()).toHaveLength(2);
    expect((await audit.verify()).ok).toBe(true);
  }, 10_000);

  it('serialises concurrent critical sections', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'x.lock');
    let counter = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withLock(lock, async () => {
          const seen = counter;
          await new Promise((r) => setTimeout(r, 5));
          counter = seen + 1;
        }),
      ),
    );
    expect(counter).toBe(10);
  });
  it('does not reclaim a living owner after the stale interval', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'long.lock');
    let active = 0;
    let maxConcurrent = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        withLock(
          lock,
          async () => {
            active += 1;
            maxConcurrent = Math.max(maxConcurrent, active);
            await new Promise((resolve) => setTimeout(resolve, 45));
            active -= 1;
          },
          { staleMs: 10, timeoutMs: 1000 },
        ),
      ),
    );
    expect(maxConcurrent).toBe(1);
  });

  it('recovers an orphaned legacy lock after its stale interval', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'orphan.lock');
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await expect(withLock(lock, async () => 'recovered', { staleMs: 10 })).resolves.toBe(
      'recovered',
    );
  });
  // A reaper that dies between creating `.reaper` and removing it leaves a fresh
  // directory with no owner in it. Contenders used to `continue` straight back to the
  // top of the loop from that branch, with no pause and no deadline check, so every
  // hook spun until the reaper aged out at 60 s — far past its own 3 s timeout and
  // the agent's hook deadline. It has to time out like any other contended lock.
  it('times out rather than spinning while another reaper holds the orphan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-lock-reaper-'));
    const lock = join(dir, 'x.lock');
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    await mkdir(`${lock}.reaper`);
    const started = Date.now();
    await expect(
      withLock(lock, async () => 'entered', { staleMs: 10, timeoutMs: 200 }),
    ).rejects.toThrow(/lock timeout/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('releases the lock when the function throws', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'y.lock');
    await expect(
      withLock(lock, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withLock(lock, async () => 'ok')).resolves.toBe('ok');
  });
  it('times out when the lock is held too long', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'z.lock');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((r) => {
      acquired = r;
    });
    const holder = withLock(
      lock,
      async () => {
        acquired();
        await held;
      },
      { staleMs: 10_000 },
    );
    await acquiredPromise; // holder definitely owns the lock now
    await expect(
      withLock(lock, async () => 1, { timeoutMs: 100, staleMs: 10_000 }),
    ).rejects.toThrow(/timeout/);
    release();
    await holder;
  });
  it('preserves the original error when releasing the lock also fails', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'w.lock');
    const rm = async () => {
      throw new Error('release failed');
    };
    const err: unknown = await withLock(
      lock,
      async () => {
        throw new Error('boom');
      },
      { fs: { mkdir, rm: rm as typeof import('node:fs/promises').rm, stat } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    expect(((err as Error).cause as Error)?.message).toBe('release failed');
  });
  it('surfaces the release error when the function itself succeeds', async () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'stroq-lock-')), 'v.lock');
    const rm = async () => {
      throw new Error('release failed');
    };
    await expect(
      withLock(lock, async () => 'ok', {
        fs: { mkdir, rm: rm as typeof import('node:fs/promises').rm, stat },
      }),
    ).rejects.toThrow('release failed');
  });
});
