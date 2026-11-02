import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KEY_CACHE_SCHEMA, type KeyCacheEntry } from '../../src/card/key-schema.js';
import {
  entriesUnder,
  keptKeys,
  keyCacheKey,
  NO_KEY_CACHE,
  readKeyCache,
  writeKeyCache,
} from '../../src/card/key-store.js';
import { cardDirIn, cardKeysFileIn } from '../../src/paths.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-key-store-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SALT = '00112233445566778899aabbccddeeff';
const DIGEST = 'ab'.repeat(32);
const entry = (over: Partial<KeyCacheEntry> = {}): KeyCacheEntry => ({
  key: keyCacheKey({ bytes: 100, mtimeMs: 5, version: '0.29.0' }),
  mtimeMs: 5,
  result: {
    id: 'session-1',
    hits: [
      {
        k: 3,
        place: {
          tier: 'third_party',
          route: 'command',
          tool: 'Bash',
          detail: 'curl',
          host: 'x.invalid',
        },
        at: '2026-10-20T10:00:00.000Z',
        last: '2026-10-20T10:00:00.000Z',
        times: 2,
        seen: 4,
        later: 0,
      },
    ],
  },
  ...over,
});
const write = (entries: Record<string, KeyCacheEntry>, digest = DIGEST): void =>
  writeKeyCache(home, { salt: SALT, digest, entries: new Map(Object.entries(entries)) });

describe('what the key check keeps', () => {
  it('reads back what it wrote', () => {
    write({ '/s/a.jsonl': entry() });
    const cache = readKeyCache(home);
    expect(cache.salt).toBe(SALT);
    expect(cache.digest).toBe(DIGEST);
    expect([...cache.entries.keys()]).toEqual(['/s/a.jsonl']);
    expect(cache.entries.get('/s/a.jsonl')).toEqual(entry());
  });

  it('is the cache of nothing when there is no file', () => {
    expect(readKeyCache(home)).toEqual(NO_KEY_CACHE);
  });

  it('is private: the folder 0700, the file 0600, and no temporary file left', () => {
    write({ '/s/a.jsonl': entry() });
    expect(statSync(cardKeysFileIn(home)).mode & 0o777).toBe(0o600);
    expect(statSync(cardDirIn(home)).mode & 0o777).toBe(0o700);
    expect(readdirSync(cardDirIn(home))).toEqual(['keys.json']);
  });

  it('tightens a folder that was made too open', () => {
    mkdirSync(cardDirIn(home), { mode: 0o755 });
    chmodSync(cardDirIn(home), 0o755);
    write({ '/s/a.jsonl': entry() });
    expect(statSync(cardDirIn(home)).mode & 0o777).toBe(0o700);
  });

  it('does not write through a link where the folder should be', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'stroq-elsewhere-'));
    symlinkSync(elsewhere, cardDirIn(home));
    expect(() => write({ '/s/a.jsonl': entry() })).toThrow(/not a plain folder/);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('does not write through a link where the file should be, and does not read one', () => {
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'stroq-elsewhere-')), 'target.json');
    writeFileSync(elsewhere, 'untouched');
    mkdirSync(cardDirIn(home), { recursive: true });
    symlinkSync(elsewhere, cardKeysFileIn(home));
    expect(readKeyCache(home)).toEqual(NO_KEY_CACHE);
    write({ '/s/a.jsonl': entry() });
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(readKeyCache(home).entries.size).toBe(1);
  });

  it('keeps the newest transcripts when there are too many', () => {
    const entries: Record<string, KeyCacheEntry> = {};
    for (let i = 0; i < 5; i += 1) entries[`/s/${i}.jsonl`] = entry({ mtimeMs: i });
    write(entries);
    expect(readKeyCache(home).entries.size).toBe(5);
  });
});

describe('what the key check does not trust', () => {
  const put = (body: unknown): void => {
    mkdirSync(cardDirIn(home), { recursive: true });
    writeFileSync(cardKeysFileIn(home), typeof body === 'string' ? body : JSON.stringify(body));
  };
  const valid = (): Record<string, unknown> => ({
    schema: KEY_CACHE_SCHEMA,
    salt: SALT,
    digest: DIGEST,
    entries: { '/s/a.jsonl': entry() },
  });

  it('accepts the file the test writes by hand, so that the cases below fail for what they change', () => {
    put(valid());
    expect(readKeyCache(home).entries.size).toBe(1);
  });

  it.each([
    ['not JSON', 'not json {'],
    ['another schema', { ...valid(), schema: 'stroq-card-keys/3' }],
    ['the schema before the window by event time', { ...valid(), schema: 'stroq-card-keys/1' }],
    ['a property it does not know', { ...valid(), extra: 1 }],
    ['a salt that is not hexadecimal', { ...valid(), salt: 'zz'.repeat(16) }],
    ['a digest of the wrong length', { ...valid(), digest: 'ab' }],
    [
      'a hit with a route it does not know',
      mutateHit((h) => ((h.place as { route: string }).route = 'teleport')),
    ],
    [
      'a hit with a property it does not know',
      mutateHit((h) => (h['value'] = 'sk_live_' + '1234567890abcdef')),
    ],
    ['a negative count', mutateHit((h) => (h['times'] = -1))],
    ['a key number that is not a number', mutateHit((h) => (h['k'] = 'seven'))],
    ['a text past its bound', mutateHit((h) => (h['at'] = 'x'.repeat(5_000)))],
    ['too many hits', tooMany()],
  ])('reads %s as nothing kept', (_what, body) => {
    put(body);
    expect(readKeyCache(home)).toEqual(NO_KEY_CACHE);
  });

  function mutateHit(change: (hit: Record<string, unknown>) => void): unknown {
    const body = valid();
    const e = (body['entries'] as Record<string, KeyCacheEntry>)['/s/a.jsonl'] as KeyCacheEntry;
    const hit = JSON.parse(JSON.stringify(e.result.hits[0])) as Record<string, unknown>;
    change(hit);
    return { ...body, entries: { '/s/a.jsonl': { ...e, result: { ...e.result, hits: [hit] } } } };
  }
  function tooMany(): unknown {
    const body = valid();
    const e = (body['entries'] as Record<string, KeyCacheEntry>)['/s/a.jsonl'] as KeyCacheEntry;
    const hits = Array.from({ length: 2_001 }, () => e.result.hits[0]);
    return { ...body, entries: { '/s/a.jsonl': { ...e, result: { ...e.result, hits } } } };
  }

  it('reads a file past its size as nothing kept', () => {
    put(' '.repeat(49 * 1024 * 1024));
    expect(readKeyCache(home)).toEqual(NO_KEY_CACHE);
  });

  it('does not use what was made for other keys', () => {
    write({ '/s/a.jsonl': entry() });
    const cache = readKeyCache(home);
    expect(entriesUnder(cache, DIGEST).size).toBe(1);
    expect(entriesUnder(cache, 'cd'.repeat(32)).size).toBe(0);
  });

  it('does not use a result for a transcript that changed or for another Stroq', () => {
    write({ '/s/a.jsonl': entry() });
    const entries = entriesUnder(readKeyCache(home), DIGEST);
    const key = (over: Partial<{ bytes: number; mtimeMs: number; version: string }>): string =>
      keyCacheKey({ bytes: 100, mtimeMs: 5, version: '0.29.0', ...over });
    expect(keptKeys(entries, '/s/a.jsonl', key({}))?.id).toBe('session-1');
    expect(keptKeys(entries, '/s/a.jsonl', key({ bytes: 101 }))).toBeNull();
    expect(keptKeys(entries, '/s/a.jsonl', key({ mtimeMs: 6 }))).toBeNull();
    expect(keptKeys(entries, '/s/a.jsonl', key({ version: '0.30.0' }))).toBeNull();
    expect(keptKeys(entries, '/s/b.jsonl', key({}))).toBeNull();
  });

  it('throws, and leaves the old file, when what it is given does not fit the schema', () => {
    write({ '/s/a.jsonl': entry() });
    const bad = entry({
      result: { id: 'x', hits: [{ ...(entry().result.hits[0] as object), k: -1 } as never] },
    });
    expect(() => write({ '/s/b.jsonl': bad })).toThrow();
    expect(readKeyCache(home).entries.has('/s/a.jsonl')).toBe(true);
    expect(existsSync(cardKeysFileIn(home))).toBe(true);
    expect(readdirSync(cardDirIn(home))).toEqual(['keys.json']);
  });
});
