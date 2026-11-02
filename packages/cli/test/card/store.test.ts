import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry, SessionSummary } from '../../src/card/schema.js';
import {
  cacheKey,
  cachedSummary,
  MAX_CACHED,
  readLastCard,
  readSessionCache,
  writeLastCard,
  writeSessionCache,
} from '../../src/card/store.js';
import { cardDirIn, cardLastFileIn, cardSessionsFileIn } from '../../src/paths.js';
import { moment } from './fixtures.js';
import { machine, type Machine } from './machine.js';

/**
 * The cache and the last card live under the Stroq home. Written whole or not at all, in a private
 * folder, never through a link; read as strictly as they are written.
 */

let m: Machine;
beforeEach(() => {
  m = machine();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const summary = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  agent: 'claude-code',
  sessionId: id,
  cwd: '/w',
  first: null,
  last: null,
  commands: 3,
  told: 0,
  moments: [],
  hours: [],
  ...over,
});
const entry = (id: string, mtimeMs = 1_000): CacheEntry => ({
  key: cacheKey({ bytes: 10, mtimeMs, version: '0.29.0', policy: 'p', keys: 'k' }),
  mtimeMs,
  summary: summary(id),
});

describe('the cache key', () => {
  it('changes with the size, the date, the version, the policy and the keys', () => {
    const base = { bytes: 10, mtimeMs: 5, version: '0.29.0', policy: 'abc', keys: 'k1' };
    const keys = new Set([
      cacheKey(base),
      cacheKey({ ...base, bytes: 11 }),
      cacheKey({ ...base, mtimeMs: 6 }),
      cacheKey({ ...base, version: '0.30.0' }),
      cacheKey({ ...base, policy: 'abd' }),
      cacheKey({ ...base, keys: 'k2' }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('is a hit only for the key that was stored', () => {
    const cache = new Map([['/a.jsonl', entry('a')]]);
    expect(cachedSummary(cache, '/a.jsonl', entry('a').key)?.sessionId).toBe('a');
    expect(cachedSummary(cache, '/a.jsonl', 'other')).toBeNull();
    expect(cachedSummary(cache, '/b.jsonl', entry('a').key)).toBeNull();
  });
});

describe('the session cache', () => {
  it('round-trips, in a folder only this user can use and a file only this user can read', () => {
    writeSessionCache(
      m.stroqHome,
      new Map([
        ['/a.jsonl', entry('a')],
        ['/b.jsonl', entry('b')],
      ]),
    );
    const back = readSessionCache(m.stroqHome);
    expect([...back.keys()].sort()).toEqual(['/a.jsonl', '/b.jsonl']);
    expect(statSync(cardDirIn(m.stroqHome)).mode & 0o777).toBe(0o700);
    expect(statSync(cardSessionsFileIn(m.stroqHome)).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    writeSessionCache(m.stroqHome, new Map([['/a.jsonl', entry('a')]]));
    writeSessionCache(m.stroqHome, new Map([['/a.jsonl', entry('a2')]]));
    expect(readdirSync(cardDirIn(m.stroqHome))).toEqual(['sessions.json']);
  });

  it('keeps only the newest transcripts', () => {
    const many = new Map<string, CacheEntry>();
    for (let i = 0; i < MAX_CACHED + 5; i += 1) many.set(`/s${i}.jsonl`, entry(`s${i}`, i));
    writeSessionCache(m.stroqHome, many);
    const back = readSessionCache(m.stroqHome);
    expect(back.size).toBe(MAX_CACHED);
    expect(back.has('/s0.jsonl')).toBe(false);
    expect(back.has(`/s${MAX_CACHED + 4}.jsonl`)).toBe(true);
  });

  it.each([
    ['not JSON', 'nope'],
    ['another schema', JSON.stringify({ schema: 'x/1', entries: {} })],
    [
      'the schema before the window by event time',
      JSON.stringify({ schema: 'stroq-card-sessions/1', entries: {} }),
    ],
    [
      'a summary with an extra field',
      JSON.stringify({
        schema: 'stroq-card-sessions/2',
        entries: { '/a': { ...entry('a'), extra: 1 } },
      }),
    ],
    [
      'a count that is not a count',
      JSON.stringify({
        schema: 'stroq-card-sessions/2',
        entries: { '/a': { ...entry('a'), summary: { ...summary('a'), commands: -1 } } },
      }),
    ],
    [
      'a huge string',
      JSON.stringify({
        schema: 'stroq-card-sessions/2',
        entries: {
          '/a': { ...entry('a'), summary: { ...summary('a'), sessionId: 'x'.repeat(5000) } },
        },
      }),
    ],
  ])('reads %s as no cache', (_name, text) => {
    mkdirSync(cardDirIn(m.stroqHome), { recursive: true });
    writeFileSync(cardSessionsFileIn(m.stroqHome), text);
    expect(readSessionCache(m.stroqHome).size).toBe(0);
  });

  it('reads a link, a folder or nothing where the file should be as no cache', () => {
    mkdirSync(cardDirIn(m.stroqHome), { recursive: true });
    expect(readSessionCache(m.stroqHome).size).toBe(0);
    mkdirSync(cardSessionsFileIn(m.stroqHome));
    expect(readSessionCache(m.stroqHome).size).toBe(0);
  });

  it('does not write through a link to the file: the link is replaced, its target is not touched', () => {
    mkdirSync(cardDirIn(m.stroqHome), { recursive: true });
    const target = join(m.root, 'precious.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, cardSessionsFileIn(m.stroqHome));
    writeSessionCache(m.stroqHome, new Map([['/a.jsonl', entry('a')]]));
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(readSessionCache(m.stroqHome).size).toBe(1);
  });

  it('refuses to write when the folder is a link', () => {
    const elsewhere = join(m.root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, cardDirIn(m.stroqHome));
    expect(() => writeSessionCache(m.stroqHome, new Map([['/a.jsonl', entry('a')]]))).toThrow(
      /plain folder/,
    );
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('closes a folder that was left open to others', () => {
    mkdirSync(cardDirIn(m.stroqHome), { recursive: true, mode: 0o777 });
    chmodSync(cardDirIn(m.stroqHome), 0o755);
    writeSessionCache(m.stroqHome, new Map([['/a.jsonl', entry('a')]]));
    expect(statSync(cardDirIn(m.stroqHome)).mode & 0o777).toBe(0o700);
  });

  it('holds no key value: the file has what was handed to it, which was scrubbed before', () => {
    const key = 'stroq_attack_0123456789abcdef0123456789abcdef';
    writeSessionCache(m.stroqHome, new Map([['/a.jsonl', entry('a')]]));
    expect(readFileSync(cardSessionsFileIn(m.stroqHome), 'utf8')).not.toContain(key);
  });
});

describe('the last card', () => {
  const meta = { version: '0.29.0', generated: '2026-11-02T10:00:00.000Z', days: 30 };

  it('round-trips, private', () => {
    writeLastCard(m.stroqHome, meta, [moment(1), moment(2)]);
    const read = readLastCard(m.stroqHome);
    expect(read.kind).toBe('card');
    if (read.kind === 'card') expect(read.card.moments.map((x) => x.n)).toEqual([1, 2]);
    expect(statSync(cardLastFileIn(m.stroqHome)).mode & 0o777).toBe(0o600);
  });

  it('reads as none when there is no file, and as unreadable when it is not a card', () => {
    expect(readLastCard(m.stroqHome)).toEqual({ kind: 'none' });
    mkdirSync(cardDirIn(m.stroqHome), { recursive: true });
    writeFileSync(cardLastFileIn(m.stroqHome), '{"schema":"stroq-card-last/1","moments":"x"}');
    expect(readLastCard(m.stroqHome).kind).toBe('unreadable');
    writeFileSync(cardLastFileIn(m.stroqHome), 'x'.repeat(2 * 1024 * 1024));
    expect(readLastCard(m.stroqHome).kind).toBe('unreadable');
  });

  it('is not written through a link either', () => {
    mkdirSync(cardDirIn(m.stroqHome), { recursive: true });
    const target = join(m.root, 'other.txt');
    writeFileSync(target, 'keep me');
    symlinkSync(target, cardLastFileIn(m.stroqHome));
    writeLastCard(m.stroqHome, meta, [moment(1)]);
    expect(readFileSync(target, 'utf8')).toBe('keep me');
    expect(existsSync(cardLastFileIn(m.stroqHome))).toBe(true);
  });
});
