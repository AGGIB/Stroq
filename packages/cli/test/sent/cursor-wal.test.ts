import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cursorStateDb, findCursorSessions, readCursorSession } from '../../src/sent/cursor.js';
import { machine, sent } from '../helpers/sent-machine.js';

/**
 * Cursor's store is in WAL mode. A read-only open of it with no other connection (Cursor not
 * running) still made `state.vscdb-shm` and `state.vscdb-wal` beside it, while every report says
 * nothing was written. Every value here is made up.
 */
const sqlite = await import('node:sqlite').catch(() => null);
const withStore = sqlite === null ? describe.skip : describe;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const bubble = (id: string, at: string): string =>
  JSON.stringify({
    _v: 3,
    type: 2,
    bubbleId: id,
    createdAt: at,
    toolFormerData: {
      toolCallId: id,
      status: 'completed',
      name: 'run_terminal_command_v2',
      params: JSON.stringify({ command: 'ls', cwd: '' }),
      result: JSON.stringify({ output: 'ok' }),
    },
  });

/** A store in WAL mode with one session, closed: only `state.vscdb` is left. */
function walStore(db: string): void {
  mkdirSync(dirname(db), { recursive: true });
  const handle = new sqlite!.DatabaseSync(db);
  handle.exec(
    'pragma journal_mode=wal; create table cursorDiskKV (key text primary key, value text)',
  );
  handle
    .prepare('insert into cursorDiskKV values (?, ?)')
    .run('bubbleId:s1:b1', bubble('b1', '2026-09-27T10:00:00.000Z'));
  handle.close();
}

const listing = (dir: string): string[] => readdirSync(dir).sort();

withStore('reading a Cursor store in WAL mode', () => {
  it('creates nothing beside the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stroq-cursor-wal-'));
    const db = join(dir, 'state.vscdb');
    walStore(db);
    expect(listing(dir)).toEqual(['state.vscdb']);
    expect(await findCursorSessions('/nowhere', db)).toHaveLength(1);
    expect((await readCursorSession(db)).sessionId).toBe('s1');
    expect(listing(dir)).toEqual(['state.vscdb']);
  });

  it('says when Cursor has changes in its write-ahead file that were not read', async () => {
    const m = machine();
    const db = cursorStateDb(
      process.platform,
      { APPDATA: join(m.home, 'AppData', 'Roaming') },
      m.home,
    );
    walStore(db);
    // Cursor running: a writer holds the store open with a change not yet in the store file.
    const live = new sqlite!.DatabaseSync(db);
    live.exec('pragma wal_autocheckpoint=0');
    live
      .prepare('insert into cursorDiskKV values (?, ?)')
      .run('bubbleId:s2:b2', bubble('b2', '2026-09-28T10:00:00.000Z'));
    try {
      const before = listing(dirname(db));
      const counts = JSON.parse((await sent(['--counts'])).out) as {
        complete: boolean;
        not_checked: string[];
      };
      expect(counts.complete).toBe(false);
      expect(counts.not_checked).toContain('cursor-recent');
      expect((await sent([])).out).toContain("Cursor's newest changes");
      expect(listing(dirname(db))).toEqual(before);
    } finally {
      live.close();
    }
  });
});
