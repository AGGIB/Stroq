import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileProvenanceStore, MAX_RECORDS } from '../../src/provenance/store.js';
import { sessionKey } from '../../src/taint/session-store.js';

const fresh = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'stroq-prov-')), 'sessions');
  return { dir, store: new FileProvenanceStore(dir) };
};
const input = (hash: string, suspect = false) => ({
  tool: 'Read',
  source: 'README.md',
  kind: 'pkg' as const,
  hash,
  excerpt: hash,
  suspect,
});

describe('FileProvenanceStore', () => {
  it('returns nothing for an unknown session', async () => {
    expect(await fresh().store.lookup('s1', ['h1'])).toEqual([]);
  });

  it('records atoms with sequence numbers and timestamps and finds them by hash', async () => {
    const { store } = fresh();
    await store.record('s1', [input('h1'), input('h2', true)]);
    const found = await store.lookup('s1', ['h2', 'nope']);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ hash: 'h2', suspect: true, seq: 2, tool: 'Read' });
    expect(Date.parse(found[0]!.at)).not.toBeNaN();
  });

  it('returns the most recent record first and continues sequence numbers across calls', async () => {
    const { store } = fresh();
    await store.record('s1', [input('h1')]);
    await store.record('s1', [input('h1', true)]);
    const found = await store.lookup('s1', ['h1']);
    expect(found.map((r) => r.seq)).toEqual([2, 1]);
    expect(found[0]?.suspect).toBe(true);
  });

  it('keeps only the newest MAX_RECORDS entries', async () => {
    const { dir, store } = fresh();
    const first = Array.from({ length: MAX_RECORDS }, (_, i) => input(`a${i}`));
    await store.record('s1', first);
    await store.record('s1', [input('b0'), input('b1'), input('b2')]);
    expect(await store.lookup('s1', ['a0', 'a1', 'a2'])).toEqual([]);
    expect(await store.lookup('s1', ['b2'])).toHaveLength(1);
    const onDisk = JSON.parse(
      readFileSync(join(dir, `${sessionKey('s1')}.prov.json`), 'utf8'),
    ) as unknown[];
    expect(onDisk).toHaveLength(MAX_RECORDS);
  });

  it('survives concurrent records without losing any', async () => {
    const { store } = fresh();
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.record('s1', [input(`c${i}`)])));
    const hashes = Array.from({ length: 8 }, (_, i) => `c${i}`);
    expect(await store.lookup('s1', hashes)).toHaveLength(8);
  });

  it('isolates sessions and ignores empty record calls', async () => {
    const { dir, store } = fresh();
    await store.record('s1', []);
    await store.record('s2', [input('h1')]);
    expect(await store.lookup('s1', ['h1'])).toEqual([]);
    expect(await store.lookup('s2', ['h1'])).toHaveLength(1);
    expect(() => statSync(join(dir, `${sessionKey('s1')}.prov.json`))).toThrow();
  });

  it('writes private files', async () => {
    const { dir, store } = fresh();
    await store.record('s1', [input('h1')]);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, `${sessionKey('s1')}.prov.json`)).mode & 0o777).toBe(0o600);
    }
  });

  it('fails closed on a corrupt file', async () => {
    const { dir, store } = fresh();
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionKey('s1')}.prov.json`), '{not json');
    await expect(store.lookup('s1', ['h'])).rejects.toThrow(/corrupt provenance/);
    await expect(store.record('s1', [input('h')])).rejects.toThrow(/corrupt provenance/);
  });

  it('fails closed on a parseable file with the wrong shape', async () => {
    const { dir, store } = fresh();
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${sessionKey('s1')}.prov.json`);
    writeFileSync(file, '{}');
    await expect(store.lookup('s1', ['h'])).rejects.toThrow(/corrupt provenance/);
    await expect(store.record('s1', [input('h')])).rejects.toThrow(/corrupt provenance/);
    expect(readFileSync(file, 'utf8')).toBe('{}');
  });
});
