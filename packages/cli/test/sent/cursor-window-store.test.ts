import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listCursorWindow } from '../../src/card/cursor-window.js';
import { readStoreRows, readStoreWindow } from '../../src/sent/cursor.js';

/**
 * The card's read of a Cursor store (#311): only the sessions with a bubble in the window count
 * against the budget, and a row the first pass cannot judge never drops its session. Every row is
 * made up here, in a throwaway store.
 */
const sqlite = await import('node:sqlite').catch(() => null);
const withStore = sqlite === null ? describe.skip : describe;

const CUTOFF = Date.parse('2026-11-01T00:00:00.000Z');
const OLD = '2026-10-01T10:00:00.000Z';
const NEW = '2026-11-10T10:00:00.000Z';
const NO_LIMIT = { stopAt: Infinity, maxRows: 1_000, maxBytes: 1_000_000 };

const bubble = (at: string | null, command = 'pwd'): string =>
  JSON.stringify({
    ...(at === null ? {} : { createdAt: at }),
    toolFormerData: { name: 'run_terminal_command_v2', params: JSON.stringify({ command }) },
  });

/** Rows in the order they are written, so the store's order is not the order of the sessions. */
const ROWS: readonly (readonly [string, string | Uint8Array | null])[] = [
  ['bubbleId:old:1', bubble(OLD)],
  ['bubbleId:recent:1', bubble(NEW, 'ls')],
  ['bubbleId:mixed:1', bubble(OLD)],
  ['bubbleId:old:2', bubble(OLD)],
  ['bubbleId:mixed:2', bubble(null)],
  ['bubbleId:recent:2', bubble(NEW, 'id')],
  ['bubbleId:mixed:3', bubble(NEW)],
  // Too deep for SQLite's JSON (1,000 levels), not for `JSON.parse`.
  ['bubbleId:deep:1', `{"createdAt":"${NEW}","x":${'['.repeat(1_100)}${']'.repeat(1_100)}}`],
  // `JSON.parse` keeps the last of two keys; SQLite's `json_extract` would read the first.
  ['bubbleId:twice:1', `{"createdAt":"${OLD}","createdAt":"${NEW}"}`],
  ['bubbleId:escaped:1', `{"\\u0063reatedAt":"${NEW}"}`],
  // SQLite reads an escaped lone surrogate as U+FFFD, where `JSON.parse` keeps it.
  ['bubbleId:surrogate:1', '{"createdAt":"Oct \\ud800 01 2026"}'],
  // An old session with a row that is not JSON: only the parse can say it holds no date.
  ['bubbleId:broken:1', bubble(OLD)],
  ['bubbleId:broken:2', '{"createdAt":'],
  // Not sessions: rows the parse never sees, keys it skips.
  ['bubbleId:binary:1', new Uint8Array([1, 2, 3])],
  ['bubbleId:binary:2', null],
  ['composerData:recent', '{"composerId":"recent"}'],
  ['bubbleId::1', bubble(NEW)],
  ['bubbleId:nobubble', bubble(NEW)],
];
const IN_WINDOW = ['recent', 'mixed', 'deep', 'twice', 'escaped'];
const HANDED_TO_PARSE = [...IN_WINDOW, 'surrogate', 'broken'];
/** The session of a bubble key, and '' for any other key. */
const sessionOf = (key: string): string =>
  key.startsWith('bubbleId:') ? (key.split(':')[1] ?? '') : '';
const WINDOW_ROWS = ROWS.filter(([key]) => HANDED_TO_PARSE.includes(sessionOf(key))).length;
/** Every session but `binary`, whose rows are not text. */
const SESSIONS = 8;

let dir = '';
let db = '';

beforeAll(() => {
  if (sqlite === null) return;
  dir = mkdtempSync(join(tmpdir(), 'stroq-cursor-window-'));
  db = join(dir, 'state.vscdb');
  const handle = new sqlite.DatabaseSync(db);
  handle.exec('create table cursorDiskKV (key text primary key, value text)');
  const put = handle.prepare('insert into cursorDiskKV values (?, ?)');
  for (const [key, value] of ROWS) put.run(key, value);
  handle.close();
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** A throwaway store of its own for one test: `fill` writes it, and it is removed after `use`. */
async function withOwnStore(
  fill: (handle: DatabaseSync) => void,
  use: (path: string) => Promise<void>,
): Promise<void> {
  const own = mkdtempSync(join(tmpdir(), 'stroq-cursor-window-'));
  const path = join(own, 'state.vscdb');
  try {
    const handle = new sqlite!.DatabaseSync(path);
    try {
      handle.exec('create table cursorDiskKV (key text primary key, value text)');
      fill(handle);
    } finally {
      handle.close();
    }
    await use(path);
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
}

const put = (handle: DatabaseSync, key: string, value: string): void => {
  handle.prepare('insert into cursorDiskKV values (?, ?)').run(key, value);
};

/**
 * With a clock that moves one step at each look, a read under every deadline it could meet
 * returns null, and stops at the first look past it. Returns how many looks a whole read takes.
 */
async function refusedAtEveryDeadline(path: string, cutoff: number): Promise<number> {
  let tick = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => tick++);
  try {
    expect(await readStoreWindow(path, cutoff, NO_LIMIT)).not.toBeNull();
    const looks = tick;
    for (let stopAt = 0; stopAt < looks; stopAt += 1) {
      tick = 0;
      expect(await readStoreWindow(path, cutoff, { ...NO_LIMIT, stopAt })).toBeNull();
      expect(tick).toBe(stopAt + 1);
    }
    return looks;
  } finally {
    clock.mockRestore();
  }
}

withStore('reading only the window of a Cursor store', () => {
  it('returns every row of the sessions that may be in the window, as a read of every row has them', async () => {
    const read = await readStoreWindow(db, CUTOFF, NO_LIMIT);
    const every = (await readStoreRows(db, null)) ?? [];
    const wanted = new Set(HANDED_TO_PARSE);
    expect(read?.rows).toEqual(every.filter((row) => wanted.has(sessionOf(row.key))));
    expect(new Set(read?.rows.map((row) => sessionOf(row.key)))).toEqual(wanted);
    expect(read?.sessions).toBe(SESSIONS);
  });

  it('shows the sessions in the window, counts the rest as older, and says nothing more', async () => {
    const listed = await listCursorWindow(db, CUTOFF, Infinity);
    expect(listed.note).toBeUndefined();
    expect(listed.sessions.map((s) => s.path.split('#')[1]).sort()).toEqual([...IN_WINDOW].sort());
    expect(listed.older).toBe(SESSIONS - IN_WINDOW.length);
  });

  it('holds the budget to the rows of the window only', async () => {
    const windowRows = (await readStoreWindow(db, CUTOFF, NO_LIMIT))?.rows ?? [];
    const bytes = windowRows.reduce(
      (sum, row) => sum + Buffer.byteLength(row.key) + Buffer.byteLength(row.value),
      0,
    );
    expect(windowRows).toHaveLength(WINDOW_ROWS);
    const exact = { stopAt: Infinity, maxRows: WINDOW_ROWS, maxBytes: bytes };
    expect((await readStoreWindow(db, CUTOFF, exact))?.rows).toHaveLength(WINDOW_ROWS);
    for (const over of [{ maxRows: WINDOW_ROWS - 1 }, { maxBytes: bytes - 1 }])
      expect(await readStoreWindow(db, CUTOFF, { ...exact, ...over })).toBeNull();
  });

  it('refuses a store with a row too large to judge, even in an old session', async () => {
    await withOwnStore(
      (handle) => {
        put(handle, 'bubbleId:recent:1', bubble(NEW));
        put(handle, 'bubbleId:old:1', bubble(OLD, 'x'.repeat(10_000)));
      },
      async (path) => {
        expect((await readStoreWindow(path, CUTOFF, NO_LIMIT))?.rows).toHaveLength(1);
        expect(await readStoreWindow(path, CUTOFF, { ...NO_LIMIT, maxBytes: 5_000 })).toBeNull();
      },
    );
  });

  it('reads a session whose newest bubble is exactly at the cutoff, as the card shows it', async () => {
    const atCutoff = Date.parse(NEW);
    const read = await readStoreWindow(db, atCutoff, NO_LIMIT);
    expect(new Set(read?.rows.map((row) => sessionOf(row.key)))).toEqual(new Set(HANDED_TO_PARSE));
    const listed = await listCursorWindow(db, atCutoff, Infinity);
    expect(listed.sessions.map((s) => s.path.split('#')[1]).sort()).toEqual([...IN_WINDOW].sort());
  });

  it('reads no rows, and says nothing, when every session is old', async () => {
    await withOwnStore(
      (handle) => {
        put(handle, 'bubbleId:first:1', bubble(OLD));
        put(handle, 'bubbleId:first:2', bubble(null));
        put(handle, 'bubbleId:second:1', bubble(OLD));
        handle.prepare('insert into cursorDiskKV values (?, ?)').run('bubbleId:third:1', null);
      },
      async (path) => {
        expect(await readStoreWindow(path, CUTOFF, NO_LIMIT)).toEqual({ rows: [], sessions: 2 });
        expect(await listCursorWindow(path, CUTOFF, Infinity)).toEqual({ sessions: [], older: 2 });
      },
    );
  });

  it('reads only the rows it could not judge when no date is in the window', async () => {
    const read = await readStoreWindow(db, Date.parse('2027-01-01T00:00:00.000Z'), NO_LIMIT);
    expect(read?.rows.map((row) => row.key).sort()).toEqual([
      'bubbleId:broken:1',
      'bubbleId:broken:2',
      'bubbleId:deep:1',
      'bubbleId:surrogate:1',
    ]);
    expect(read?.sessions).toBe(SESSIONS);
  });

  it('stops at the first look at the clock past the deadline, and looks at it on every row', async () => {
    const looks = await refusedAtEveryDeadline(db, CUTOFF);
    // Every bubble row of the first pass, and every row of the second.
    expect(looks).toBeGreaterThanOrEqual(ROWS.length - 1 + WINDOW_ROWS);
  });

  it('does not return an empty window once the deadline has passed', async () => {
    await withOwnStore(
      (handle) => {
        put(handle, 'bubbleId:first:1', bubble(OLD));
        put(handle, 'bubbleId:second:1', bubble(OLD));
      },
      async (path) => {
        // The start, the two rows, and once more after the first pass.
        expect(await refusedAtEveryDeadline(path, CUTOFF)).toBe(4);
      },
    );
  });

  it('says the store was not read in full when the deadline has passed', async () => {
    const listed = await listCursorWindow(db, CUTOFF, Date.now() - 1);
    expect(listed.sessions).toEqual([]);
    expect(listed.note).toContain('could not be read in full');
  });

  /** Writes `<prefix>` + a byte that is not UTF-8 + `<suffix>`: it reads back as U+FFFD. */
  const putNotUtf8 = (
    handle: DatabaseSync,
    prefix: string,
    suffix: string,
    value: string,
  ): void => {
    handle
      .prepare("insert into cursorDiskKV values (cast(? as text) || cast(x'ff' as text) || ?, ?)")
      .run(prefix, suffix, value);
  };

  it('returns nothing when the second pass finds no row of a session the first one counted', async () => {
    // The session reads back as `bad` + U+FFFD, and that text names no row on the second pass.
    await withOwnStore(
      (handle) => putNotUtf8(handle, 'bubbleId:bad', ':1', bubble(NEW)),
      async (path) => expect(await readStoreWindow(path, CUTOFF, NO_LIMIT)).toBeNull(),
    );
  });

  it('returns nothing when the second pass finds fewer rows of a session than the first counted', async () => {
    // Two keys the first pass reads as one session, `a` + U+FFFD: one written as UTF-8, one with a
    // byte that is not. The second pass finds only the first, as if a row had gone between the two.
    // (A row written by another connection between the passes cannot stand in: the handle is
    // immutable, keeps its pages, and sees the store as the first pass did.)
    await withOwnStore(
      (handle) => {
        put(handle, 'bubbleId:a\uFFFD:1', bubble(NEW));
        putNotUtf8(handle, 'bubbleId:a', ':2', bubble(NEW));
      },
      async (path) => expect(await readStoreWindow(path, CUTOFF, NO_LIMIT)).toBeNull(),
    );
    await withOwnStore(
      (handle) => put(handle, 'bubbleId:a\uFFFD:1', bubble(NEW)),
      async (path) => expect((await readStoreWindow(path, CUTOFF, NO_LIMIT))?.rows).toHaveLength(1),
    );
  });
});
