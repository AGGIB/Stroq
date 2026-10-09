import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_REQUEST_LIMIT, openLedger } from '../../src/live/budget.js';
import { readLedgerFile } from '../../src/live/ledger-file.js';
import { inChild } from './child.js';

/**
 * The owner's account is the budget of this check: a host request costs a share of a usage limit
 * that the owner's real work needs. The cap is held by a file, so that it holds across runs and across
 * processes, and by nothing the model or the host says.
 */
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-live-ledger-'));
  file = join(dir, 'state', 'ledger.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the cap', () => {
  it('is thirty requests', () => {
    expect(LIVE_REQUEST_LIMIT).toBe(30);
  });
});

describe('a ledger in memory', () => {
  it('gives out requests up to the cap and not one more', async () => {
    const ledger = openLedger({ limit: 3 });
    expect(await ledger.take(1, 'allow')).toEqual({ ok: true, used: 1, limit: 3 });
    expect(await ledger.take(1, 'deny')).toEqual({ ok: true, used: 2, limit: 3 });
    expect(await ledger.take(1, 'egress')).toEqual({ ok: true, used: 3, limit: 3 });
    expect(await ledger.take(1, 'again')).toMatchObject({
      ok: false,
      why: 'limit-reached',
      used: 3,
      limit: 3,
    });
    expect(await ledger.peek()).toEqual({ ok: true, used: 3, limit: 3 });
  });

  it('takes nothing of a request that would go over, so that a smaller one can still be made', async () => {
    const ledger = openLedger({ limit: 3 });
    await ledger.take(2, 'two');
    expect(await ledger.take(2, 'two more')).toMatchObject({ ok: false, why: 'limit-reached' });
    expect(await ledger.take(1, 'one')).toEqual({ ok: true, used: 3, limit: 3 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'will not take %s requests',
    async (n) => {
      const ledger = openLedger({ limit: 3 });
      expect(await ledger.take(n, 'bad')).toMatchObject({ ok: false, why: 'invalid-request' });
      expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: 3 });
    },
  );

  it('does not share its count with another ledger', async () => {
    const one = openLedger({ limit: 1 });
    const other = openLedger({ limit: 1 });
    await one.take(1, 'a');
    expect(await other.take(1, 'b')).toMatchObject({ ok: true });
  });

  it('treats an empty path as no path, as an empty STROQ_HOME is no home', async () => {
    const ledger = openLedger({ path: '', limit: 1 });
    await ledger.take(1, 'a');
    expect(await ledger.take(1, 'b')).toMatchObject({ ok: false, why: 'limit-reached' });
  });

  it.each([0, -3, 2.5, Number.NaN])('will not open with a cap of %s', (limit) => {
    expect(() => openLedger({ limit })).toThrow(/cap/);
  });
});

describe('a ledger in a file', () => {
  it('writes what was taken, with the time and the reason, where it was asked to', async () => {
    const ledger = openLedger({
      path: file,
      limit: 30,
      now: () => new Date('2026-10-10T01:02:03.456Z'),
    });
    await ledger.take(1, 'claude-code: allow');
    await ledger.take(1, 'claude-code: deny');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      version: 1,
      limit: 30,
      used: 2,
      entries: [
        { at: '2026-10-10T01:02:03.456Z', reason: 'claude-code: allow' },
        { at: '2026-10-10T01:02:03.456Z', reason: 'claude-code: deny' },
      ],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the file and its directory to their owner',
    async () => {
      await openLedger({ path: file, limit: 30 }).take(1, 'a');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
    },
  );

  it('remembers across ledgers, as it must across runs', async () => {
    await openLedger({ path: file, limit: 3 }).take(2, 'first run');
    const later = openLedger({ path: file, limit: 3 });
    expect(await later.peek()).toEqual({ ok: true, used: 2, limit: 3 });
    expect(await later.take(2, 'second run')).toMatchObject({ ok: false, why: 'limit-reached' });
    expect(await later.take(1, 'second run')).toMatchObject({ ok: true, used: 3 });
  });

  it('reads nothing into a file that is not there yet', async () => {
    expect(await openLedger({ path: file, limit: 30 }).peek()).toEqual({
      ok: true,
      used: 0,
      limit: 30,
    });
  });

  // The cap is the owner's, and a program that is handed a larger number must not be able to spend it.
  it('holds to the smaller of the cap in the file and the cap it is opened with', async () => {
    await openLedger({ path: file, limit: 5 }).take(1, 'a');
    const wider = openLedger({ path: file, limit: 30 });
    expect(await wider.peek()).toEqual({ ok: true, used: 1, limit: 5 });
    expect(await wider.take(4, 'b')).toMatchObject({ ok: true, used: 5, limit: 5 });
    expect(await wider.take(1, 'c')).toMatchObject({ ok: false, why: 'limit-reached', limit: 5 });
    const narrower = openLedger({ path: file, limit: 2 });
    expect(await narrower.take(1, 'd')).toMatchObject({
      ok: false,
      why: 'limit-reached',
      limit: 2,
    });
  });

  it('never gives out more than the cap when many ask at once, from several ledgers', async () => {
    const ledgers = [1, 2, 3].map(() =>
      openLedger({ path: file, limit: 30, lockTimeoutMs: 30_000 }),
    );
    const asks = Array.from({ length: 40 }, (_, i) =>
      ledgers[i % ledgers.length]!.take(1, `request ${i}`),
    );
    const results = await Promise.all(asks);
    expect(results.filter((r) => r.ok)).toHaveLength(30);
    expect(results.filter((r) => !r.ok && r.why === 'limit-reached')).toHaveLength(10);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { used: number; entries: unknown[] };
    expect(stored.used).toBe(30);
    expect(stored.entries).toHaveLength(30);
  }, 60_000);

  it('says the ledger is busy, and takes nothing, when another holds it and does not let go', async () => {
    mkdirSync(join(dir, 'state'), { recursive: true });
    mkdirSync(`${file}.lock`);
    writeFileSync(
      join(`${file}.lock`, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: hostname(), token: 'someone-else' }),
    );
    const ledger = openLedger({ path: file, limit: 30, lockTimeoutMs: 80 });
    expect(await ledger.take(1, 'a')).toMatchObject({ ok: false, why: 'busy' });
    rmSync(`${file}.lock`, { recursive: true });
    expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: 30 });
  });

  it('keeps the newest two hundred entries and goes on counting every request', async () => {
    const ledger = openLedger({ path: file, limit: 300 });
    for (let i = 0; i < 250; i += 1) await ledger.take(1, `request ${i}`);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      used: number;
      entries: { reason: string }[];
    };
    expect(stored.used).toBe(250);
    expect(stored.entries).toHaveLength(200);
    expect(stored.entries[0]?.reason).toBe('request 50');
    expect(stored.entries.at(-1)?.reason).toBe('request 249');
    expect(await ledger.peek()).toEqual({ ok: true, used: 250, limit: 300 });
  }, 60_000);

  it('cleans what the agent put in a reason, and keeps it short', async () => {
    const ledger = openLedger({ path: file, limit: 30 });
    await ledger.take(1, 'a\u001b[2Jb\nc');
    await ledger.take(1, 'x'.repeat(500));
    await ledger.take(1, '');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { entries: { reason: string }[] };
    for (const entry of stored.entries) {
      expect(entry.reason).toMatch(/^[\x20-\x7e]{1,80}$/);
    }
    expect(stored.entries[0]?.reason).toBe('a?[2Jb?c');
    expect(stored.entries[2]?.reason).toBe('-');
  });

  describe('a file that is not a ledger', () => {
    const refuses = async (text: string | null, why = 'unreadable'): Promise<void> => {
      mkdirSync(join(dir, 'state'), { recursive: true });
      if (text !== null) writeFileSync(file, text);
      const ledger = openLedger({ path: file, limit: 30 });
      const before = text === null ? null : readFileSync(file, 'utf8');
      expect(await ledger.take(1, 'a')).toMatchObject({ ok: false, why });
      expect(await ledger.peek()).toMatchObject({ ok: false });
      // Not mended and not reset: a ledger that forgave a broken file would give the cap away.
      if (before !== null) expect(readFileSync(file, 'utf8')).toBe(before);
    };
    const good = {
      version: 1,
      limit: 30,
      used: 1,
      entries: [{ at: '2026-10-10T01:02:03.456Z', reason: 'a' }],
    };

    it.each([
      ['not JSON', '{"version":1,'],
      ['empty', ''],
      ['a list', '[]'],
      ['another version', JSON.stringify({ ...good, version: 2 })],
      ['a negative count', JSON.stringify({ ...good, used: -1 })],
      ['a fractional count', JSON.stringify({ ...good, used: 1.5 })],
      ['a count below the number of entries', JSON.stringify({ ...good, used: 0 })],
      ['a cap of zero', JSON.stringify({ ...good, limit: 0 })],
      ['entries that are not a list', JSON.stringify({ ...good, entries: {} })],
      ['an entry without a time', JSON.stringify({ ...good, entries: [{ reason: 'a' }] })],
      [
        'an entry with a time in other words',
        JSON.stringify({ ...good, entries: [{ at: 'yesterday', reason: 'a' }] }),
      ],
      ['an extra key', JSON.stringify({ ...good, bonus: 100 })],
      [
        'an extra key in an entry',
        JSON.stringify({ ...good, entries: [{ ...good.entries[0], n: 1 }] }),
      ],
      [
        'more entries than a ledger holds',
        JSON.stringify({
          ...good,
          used: 201,
          entries: Array.from({ length: 201 }, () => good.entries[0]),
        }),
      ],
    ])('refuses %s, and takes nothing', async (_name, text) => {
      await refuses(text);
    });

    it('refuses a file of more than 64 KiB', async () => {
      await refuses(`${JSON.stringify(good)}${' '.repeat(70_000)}`);
    });

    it('refuses a directory in its place', async () => {
      mkdirSync(file, { recursive: true });
      const ledger = openLedger({ path: file, limit: 30 });
      expect(await ledger.take(1, 'a')).toMatchObject({ ok: false, why: 'unreadable' });
    });

    it.skipIf(process.platform === 'win32')('refuses a link, even to a good ledger', async () => {
      mkdirSync(join(dir, 'state'), { recursive: true });
      const real = join(dir, 'real.json');
      writeFileSync(real, JSON.stringify(good));
      symlinkSync(real, file);
      const ledger = openLedger({ path: file, limit: 30 });
      expect(await ledger.take(1, 'a')).toMatchObject({ ok: false, why: 'unreadable' });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'says it cannot write, and takes nothing, when the directory is closed',
      async () => {
        mkdirSync(join(dir, 'state'), { recursive: true });
        const ledger = openLedger({ path: file, limit: 30 });
        chmodSync(join(dir, 'state'), 0o500);
        try {
          expect(await ledger.take(1, 'a')).toMatchObject({ ok: false, why: 'unwritable' });
        } finally {
          chmodSync(join(dir, 'state'), 0o700);
        }
        expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: 30 });
      },
    );
  });
});

describe('readLedgerFile', () => {
  it.skipIf(process.platform === 'win32')(
    'does not wait for a FIFO in the place of the ledger',
    () => {
      mkdirSync(join(dir, 'state'), { recursive: true });
      execFileSync('mkfifo', [file]);
      const source = fileURLToPath(new URL('../../src/live/ledger-file.ts', import.meta.url));
      const read = inChild(source, 'readLedgerFile', [file]);
      expect(read).toMatchObject({ kind: 'problem' });
    },
  );

  it('says a file that is not there is absent', () => {
    expect(readLedgerFile(file)).toEqual({ kind: 'absent' });
  });
});
