import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
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
});
