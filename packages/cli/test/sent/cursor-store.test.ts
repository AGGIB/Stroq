import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cursorSessionPath,
  cursorUnavailable,
  findCursorSessions,
  readCursorSession,
} from '../../src/sent/cursor.js';
import { readerForFile } from '../../src/sent/readers.js';

/**
 * The half of the reader the pure parse tests cannot reach: opening a real store.
 *
 * `node:sqlite` is not in every Node this package supports — 22.11.0 does not have
 * it at all — so the suite says which it is rather than failing on a machine where
 * the feature genuinely cannot run. On a Node that has it, these run.
 */
const sqlite = await import('node:sqlite').catch(() => null);
const withStore = sqlite === null ? describe.skip : describe;

let dir = '';
let db = '';

const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-000000000002';

beforeAll(() => {
  if (sqlite === null) return;
  dir = mkdtempSync(join(tmpdir(), 'stroq-cursor-'));
  db = join(dir, 'state.vscdb');
  const handle = new sqlite.DatabaseSync(db);
  handle.exec('create table cursorDiskKV (key text primary key, value text)');
  const insert = handle.prepare('insert into cursorDiskKV (key, value) values (?, ?)');
  const bubble = (session: string, id: string, tool: Record<string, unknown>, at: string): void => {
    insert.run(
      `bubbleId:${session}:${id}`,
      JSON.stringify({
        _v: 3,
        type: 2,
        bubbleId: id,
        createdAt: at,
        toolFormerData: { toolCallId: id, status: 'completed', ...tool },
      }),
    );
  };
  bubble(
    SESSION_A,
    'a1',
    {
      name: 'read_file_v2',
      params: JSON.stringify({ targetFile: '/work/alpha/config.yml' }),
      result: JSON.stringify({ contents: 'token: shhh\n' }),
    },
    '2026-04-27T10:00:00.000Z',
  );
  bubble(
    SESSION_B,
    'b1',
    {
      name: 'run_terminal_command_v2',
      params: JSON.stringify({ command: 'env', cwd: '' }),
      result: JSON.stringify({ output: 'PATH=/usr/bin\n' }),
    },
    '2026-04-28T10:00:00.000Z',
  );
  // A row the reader must ignore rather than mistake for a session.
  insert.run('composerData:something', '{"composerId":"something"}');
  handle.close();
});

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

withStore('reading a real Cursor store', () => {
  it('lists every session, newest first', async () => {
    const found = await findCursorSessions('/nowhere', db);
    expect(found.map((f) => f.path)).toEqual([
      cursorSessionPath(db, SESSION_B),
      cursorSessionPath(db, SESSION_A),
    ]);
    expect(found[0]?.mtimeMs).toBe(Date.parse('2026-04-28T10:00:00.000Z'));
  });

  it('narrows to the sessions that touched a directory', async () => {
    const found = await findCursorSessions('/work/alpha', db);
    expect(found.map((f) => f.path)).toEqual([cursorSessionPath(db, SESSION_A)]);
  });

  it('matches a directory on a boundary, never on a bare prefix', async () => {
    // `/work/alph` must not claim `/work/alpha/config.yml`, so this falls back to
    // every session rather than reporting a match that is a string coincidence.
    const found = await findCursorSessions('/work/alph', db);
    expect(found).toHaveLength(2);
  });

  it('reads one named session out of the store', async () => {
    const transcript = await readCursorSession(cursorSessionPath(db, SESSION_A));
    expect(transcript.sessionId).toBe(SESSION_A);
    expect(transcript.events.map((e) => e.kind)).toEqual(['pre', 'post']);
    const post = transcript.events[1];
    expect(post?.kind === 'post' && post.resultText).toBe('token: shhh\n');
  });

  it('reads the newest session when the path names none', async () => {
    const transcript = await readCursorSession(db);
    expect(transcript.sessionId).toBe(SESSION_B);
  });

  it('answers a store it cannot open with an empty session rather than a throw', async () => {
    const transcript = await readCursorSession(join(dir, 'not-a-store.vscdb'));
    expect(transcript.events).toEqual([]);
  });

  it('dispatches a store path to the Cursor reader, session suffix and all', async () => {
    expect((await readerForFile(db)).agent).toBe('cursor');
    expect((await readerForFile(cursorSessionPath(db, SESSION_A))).agent).toBe('cursor');
  });

  it('reports itself available on a Node that has node:sqlite', async () => {
    expect(await cursorUnavailable()).toBeNull();
  });
});
