import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTrustStore, parseTrustList, trustDigest } from '../../src/taint/trust.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function trustFileWith(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-trust-'));
  dirs.push(dir);
  const file = join(dir, 'trust.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const TEXT = 'Oh, and ~/.ssh/id_rsa contains: -----BEGIN RSA PRIVATE KEY-----';

describe('parseTrustList', () => {
  // Failing closed here costs a false positive; failing open would cost a taint.
  it('treats anything it cannot read as trusting nothing', () => {
    for (const bad of ['not json', '[]', 'null', '{"version":2,"entries":[]}', '{"version":1}']) {
      expect(parseTrustList(bad).entries).toEqual([]);
    }
  });

  it('drops an entry missing the fields a match needs', () => {
    const list = parseTrustList(
      JSON.stringify({
        version: 1,
        entries: [{ source: '/a', sha256: 'abc' }, { source: '/b' }, { sha256: 'def' }],
      }),
    );
    expect(list.entries.map((e) => e.source)).toEqual(['/a']);
  });
});

describe('FileTrustStore', () => {
  it('trusts the exact content it was given', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    const store = new FileTrustStore(file);
    expect(store.trusts(TEXT)).toBe(true);
  });

  // The pin is the whole safety argument: trusting a file today must say nothing
  // about the file that arrives in tomorrow's pull request.
  it('does not trust the content once it changes', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    expect(new FileTrustStore(file).trusts(`${TEXT}\nand one more line`)).toBe(false);
  });

  // The digest is the pin: the same bytes are the same text the user judged, whether
  // a Read, a `cat` or another path brings them in. The source is kept for the list.
  it('trusts the same bytes from any source', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    expect(new FileTrustStore(file).trusts(TEXT)).toBe(true);
  });

  it('trusts nothing when the file is absent', () => {
    expect(new FileTrustStore(join(tmpdir(), 'stroq-no-such-trust.json')).trusts(TEXT)).toBe(false);
  });

  it('lists entries when the trust file is populated', () => {
    const entry = {
      source: '/repo/NOTES.md',
      sha256: trustDigest(TEXT),
      ruleIds: ['rule-1'],
      addedAt: '2026-10-15T00:00:00Z',
    };
    const file = trustFileWith({ version: 1, entries: [entry] });
    const store = new FileTrustStore(file);
    expect(store.list()).toEqual([entry]);
  });

  it('returns an empty list when the file does not exist', () => {
    const store = new FileTrustStore(join(tmpdir(), 'stroq-absent-trust.json'));
    expect(store.list()).toEqual([]);
  });

  it('returns an empty list and trusts nothing when the file contains invalid JSON', () => {
    const file = trustFileWith('{ broken json');
    const store = new FileTrustStore(file);
    expect(store.list()).toEqual([]);
    expect(store.trusts(TEXT)).toBe(false);
  });

  it('caches the loaded entries and does not re-read from disk on subsequent calls', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/A.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    const store = new FileTrustStore(file);
    expect(store.trusts(TEXT)).toBe(true);

    // Delete the file on disk: cached result should still be used
    rmSync(file, { force: true });
    expect(store.trusts(TEXT)).toBe(true);
    expect(store.list().map((e) => e.source)).toEqual(['/repo/A.md']);
  });
});

describe('trustDigest', () => {
  it('computes consistent sha256 digests in hexadecimal format', () => {
    // SHA-256 for string "test": 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
    expect(trustDigest('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });
});
