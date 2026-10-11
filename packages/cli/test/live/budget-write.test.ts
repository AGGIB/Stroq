import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openLedger } from '../../src/live/budget.js';
import { writeLedgerFile } from '../../src/live/ledger-file.js';

// The write is the one step of a take that is not under test's control, so it is made to fail here.
vi.mock('../../src/live/ledger-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/live/ledger-file.js')>();
  return { ...actual, writeLedgerFile: vi.fn(actual.writeLedgerFile) };
});

/**
 * A request that could not be written down was not spent, and was not made: the ledger says it could
 * not write, the count stays where it was, and the caller does not go on to spend what was not counted.
 */
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-live-ledger-write-'));
  file = join(dir, 'state', 'ledger.json');
  vi.mocked(writeLedgerFile).mockClear();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a ledger that cannot write', () => {
  it('takes nothing when the disk is full, and says so', async () => {
    vi.mocked(writeLedgerFile).mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    const ledger = openLedger({ path: file, limit: 30 });
    expect(await ledger.take(1, 'a')).toEqual({
      ok: false,
      why: 'unwritable',
      used: 0,
      limit: 30,
      problem: 'ENOSPC',
    });
    expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: 30 });
    // The next one goes through: the lock was let go.
    expect(await ledger.take(1, 'b')).toMatchObject({ ok: true, used: 1 });
  });

  it('says the write failed even when the error has no code to name it by', async () => {
    vi.mocked(writeLedgerFile).mockImplementationOnce(() => {
      throw new Error('something else');
    });
    expect(await openLedger({ path: file, limit: 30 }).take(1, 'a')).toMatchObject({
      ok: false,
      why: 'unwritable',
      problem: 'write failed',
    });
  });

  it('says it cannot make the directory when there is a file where it should go', async () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file');
    const ledger = openLedger({ path: join(blocker, 'ledger.json'), limit: 30 });
    expect(await ledger.take(1, 'a')).toMatchObject({
      ok: false,
      why: 'unwritable',
      // What a system calls a file where a directory should be is its own to say.
      problem: expect.stringMatching(/^(ENOTDIR|EEXIST)$/),
    });
  });
});
