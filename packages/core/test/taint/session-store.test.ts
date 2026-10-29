import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSessionStore, sessionKey } from '../../src/taint/session-store.js';

const fresh = () =>
  new FileSessionStore(join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions'));
const src = (tool: string) => ({
  tool,
  ruleIds: ['STROQ-2026-00001'],
  at: '2026-09-03T00:00:00.000Z',
});

describe('FileSessionStore', () => {
  it('returns an untainted state for an unknown session', async () => {
    const state = await fresh().get('s1');
    expect(state).toMatchObject({ sessionId: 's1', taint: null });
  });
  it('marks a session suspect and persists it', async () => {
    const store = fresh();
    const state = await store.markSuspect('s1', src('Read'));
    expect(state.taint?.level).toBe('suspect');
    expect(state.taint?.sources).toHaveLength(1);
    expect((await store.get('s1')).taint?.since).toBe(state.taint?.since);
  });
  it('appends sources on repeated marks and keeps the original since', async () => {
    const store = fresh();
    const first = await store.markSuspect('s1', src('Read'));
    const second = await store.markSuspect('s1', src('WebFetch'));
    expect(second.taint?.since).toBe(first.taint?.since);
    expect(second.taint?.sources.map((s) => s.tool)).toEqual(['Read', 'WebFetch']);
  });
  it('survives concurrent marks without losing sources', async () => {
    const store = fresh();
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.markSuspect('s1', src(`t${i}`))));
    expect((await store.get('s1')).taint?.sources).toHaveLength(8);
  });
  it('clears taint', async () => {
    const store = fresh();
    await store.markSuspect('s1', src('Read'));
    await store.clear('s1');
    expect((await store.get('s1')).taint).toBeNull();
  });
  it('never corrupts state when clear races with markSuspect', async () => {
    const store = fresh();
    for (let i = 0; i < 10; i++) {
      await expect(
        Promise.all([store.markSuspect('s1', src(`race${i}`)), store.clear('s1')]),
      ).resolves.toBeDefined();
      const state = await store.get('s1');
      if (state.taint === null) {
        continue;
      }
      expect(Array.isArray(state.taint.sources)).toBe(true);
      expect(state.taint.sources.every((s) => typeof s.tool === 'string')).toBe(true);
    }
  });
  it('throws a clear error when the session file contains invalid JSON', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sessionKey('s1')}.json`), 'not json', 'utf8');
    const store = new FileSessionStore(dir);
    await expect(store.get('s1')).rejects.toThrow(/corrupt session state/);
  });
  it('rejects valid JSON with an unknown taint level instead of treating it as clean', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionKey('s1')}.json`),
      JSON.stringify({
        sessionId: 's1',
        taint: { level: 'BROKEN', since: '2026-09-23T00:00:00Z', sources: [] },
        updatedAt: '2026-09-23T00:00:00Z',
      }),
      'utf8',
    );
    await expect(new FileSessionStore(dir).get('s1')).rejects.toThrow(/corrupt session state/);
  });
  it('notes flags on own text apart from the taint, counting them and keeping the last', async () => {
    const store = fresh();
    const first = await store.markFlagged('s1', src('Read'));
    expect(first.taint).toBeNull();
    expect(first.flagged).toMatchObject({ count: 1, last: { tool: 'Read' } });
    const second = await store.markFlagged('s1', src('Bash'));
    expect(second.flagged).toMatchObject({ since: first.flagged?.since, count: 2 });
    expect(second.flagged?.last.tool).toBe('Bash');
    expect(await store.get('s1')).toEqual(second);
  });
  it('keeps the note when the session is tainted, and clears both together', async () => {
    const store = fresh();
    await store.markFlagged('s1', src('Read'));
    const tainted = await store.markSuspect('s1', src('WebFetch'));
    expect(tainted.flagged?.count).toBe(1);
    expect(tainted.taint?.level).toBe('suspect');
    await store.clear('s1');
    const cleared = await store.get('s1');
    expect(cleared.flagged).toBeUndefined();
    expect(cleared.taint).toBeNull();
  });
  it.each([
    ['a count that is not a number', { since: 'x', count: '1', last: src('Read') }],
    ['a count of zero', { since: 'x', count: 0, last: src('Read') }],
    ['a last flag with no tool', { since: 'x', count: 1, last: { ruleIds: [], at: 'x' } }],
    ['a note that is a list', [src('Read')]],
  ])('rejects a note with %s instead of reading past it', async (_name, flagged) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionKey('s1')}.json`),
      JSON.stringify({ sessionId: 's1', taint: null, updatedAt: 'x', flagged }),
    );
    await expect(new FileSessionStore(dir).get('s1')).rejects.toThrow(/corrupt session state/);
  });
  it('notes downloaded files once each, the newest last, and keeps at most 64', async () => {
    const store = fresh();
    await store.markFetched('s1', ['/p/a.html', '/p/b.html']);
    const again = await store.markFetched('s1', ['/p/a.html']);
    expect(again.fetched).toEqual(['/p/b.html', '/p/a.html']);
    const many = Array.from({ length: 70 }, (_, i) => `/p/f${i}.html`);
    const capped = await store.markFetched('s1', many);
    expect(capped.fetched).toHaveLength(64);
    expect(capped.fetched?.at(-1)).toBe('/p/f69.html');
    expect(await store.get('s1')).toEqual(capped);
  });
  it.each([
    ['a list that is not of paths', [1, 2]],
    ['an empty path', ['']],
    ['too many', Array.from({ length: 65 }, (_, i) => `/p/${i}`)],
  ])('rejects downloaded files with %s', async (_name, fetched) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${sessionKey('s1')}.json`),
      JSON.stringify({ sessionId: 's1', taint: null, updatedAt: 'x', fetched }),
    );
    await expect(new FileSessionStore(dir).get('s1')).rejects.toThrow(/corrupt session state/);
  });
  it('never uses the raw session id as a file name', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions');
    await new FileSessionStore(dir).markSuspect('../../etc/passwd', src('Read'));
    expect(readdirSync(dir).every((f) => /^[0-9a-f]{16}\.json$/.test(f))).toBe(true);
    expect(existsSync(join(dir, '..', '..', 'etc'))).toBe(false);
  });
  it('sessionKey is a stable 16-hex-char digest', () => {
    expect(sessionKey('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionKey('abc')).toBe(sessionKey('abc'));
  });

  it.skipIf(process.platform === 'win32')(
    'creates the sessions dir with 0700 and session files with 0600',
    async () => {
      const dir = join(mkdtempSync(join(tmpdir(), 'stroq-sess-')), 'sessions');
      const store = new FileSessionStore(dir);
      await store.markSuspect('s1', src('Read'));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, `${sessionKey('s1')}.json`)).mode & 0o777).toBe(0o600);
    },
  );
});
