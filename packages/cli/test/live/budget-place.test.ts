import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIVE_REQUEST_LIMIT, ledgerFromEnv, openLedger } from '../../src/live/budget.js';
import { LiveCheckError } from '../../src/live/errors.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stroq-live-ledger-place-'));
  file = join(dir, 'state', 'ledger.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// A budget that quietly became a count in memory, because nobody named a file, would be a cap that
// every run starts over from zero: the owner's account has no cap at all. So it has to be asked for.
describe('a ledger with no place to keep its count', () => {
  const refusal = (open: () => unknown): LiveCheckError => {
    try {
      open();
    } catch (err) {
      if (err instanceof LiveCheckError) return err;
      throw err;
    }
    throw new Error('expected the ledger to be refused');
  };

  it('throws when it is given no path, and was not told out loud that memory will do', () => {
    expect(refusal(() => openLedger({ limit: 30 })).code).toBe('invalid-ledger');
    expect(refusal(() => openLedger({ limit: 30, path: undefined })).code).toBe('invalid-ledger');
    expect(refusal(() => openLedger({ limit: 30 })).message).toMatch(/memory: true/);
  });

  it('does not take memory: false as leave to go without a path', () => {
    expect(refusal(() => openLedger({ limit: 30, memory: false })).code).toBe('invalid-ledger');
  });

  it.each([
    ['an empty path', ''],
    ['a path of spaces', '   '],
    ['a bare file name', 'ledger.json'],
    ['a path from here', './ledger.json'],
    ['a path from the parent', '../ledger.json'],
    ['a path from a directory', 'state/ledger.json'],
    ['a path with a NUL in it', '/tmp/a\u0000b/ledger.json'],
  ])(
    'refuses %s, which names no place that does not depend on where the program is',
    (_n, path) => {
      expect(refusal(() => openLedger({ path, limit: 30 })).code).toBe('invalid-ledger');
    },
  );

  it('does not let an empty path stand for memory, as an empty STROQ_HOME is no home', () => {
    expect(refusal(() => openLedger({ path: '', limit: 30, memory: true })).code).toBe(
      'invalid-ledger',
    );
  });

  it('refuses a path and memory together: it is one or the other', () => {
    expect(refusal(() => openLedger({ path: file, limit: 30, memory: true })).code).toBe(
      'invalid-ledger',
    );
  });

  it('opens at a path that is absolute', async () => {
    const ledger = openLedger({ path: file, limit: 30 });
    expect(await ledger.take(1, 'a')).toMatchObject({ ok: true, used: 1 });
  });
});

describe('ledgerFromEnv', () => {
  const refusal = (env: Record<string, string | undefined>): LiveCheckError => {
    try {
      ledgerFromEnv(env);
    } catch (err) {
      if (err instanceof LiveCheckError) return err;
      throw err;
    }
    throw new Error('expected the environment to be refused');
  };

  it.each([
    ['not set', {}],
    ['set to nothing', { STROQ_LIVE_LEDGER: '' }],
    ['set to undefined', { STROQ_LIVE_LEDGER: undefined }],
    ['set to a relative path', { STROQ_LIVE_LEDGER: 'ledger.json' }],
  ])('throws when STROQ_LIVE_LEDGER is %s, and names the variable', (_name, env) => {
    const error = refusal(env);
    expect(error.code).toBe('invalid-ledger');
    expect(error.message).toContain('STROQ_LIVE_LEDGER');
  });

  it('opens the ledger the variable names, with the cap of the owner', async () => {
    const ledger = ledgerFromEnv({ STROQ_LIVE_LEDGER: file });
    expect(await ledger.peek()).toEqual({ ok: true, used: 0, limit: LIVE_REQUEST_LIMIT });
    expect(await ledger.take(1, 'a')).toMatchObject({ ok: true, used: 1 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ used: 1, limit: 30 });
  });

  it('remembers across calls, as the file does', async () => {
    await ledgerFromEnv({ STROQ_LIVE_LEDGER: file }).take(2, 'first');
    expect(await ledgerFromEnv({ STROQ_LIVE_LEDGER: file }).peek()).toMatchObject({ used: 2 });
  });

  it('reads the environment it is given and not the one of the process', () => {
    const saved = process.env['STROQ_LIVE_LEDGER'];
    process.env['STROQ_LIVE_LEDGER'] = file;
    try {
      expect(refusal({}).code).toBe('invalid-ledger');
    } finally {
      if (saved === undefined) delete process.env['STROQ_LIVE_LEDGER'];
      else process.env['STROQ_LIVE_LEDGER'] = saved;
    }
  });
});
