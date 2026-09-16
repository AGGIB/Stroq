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
  it('trusts the exact content it was given, from the source it was given', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    const store = new FileTrustStore(file);
    expect(store.trusts('/repo/NOTES.md', TEXT)).toBe(true);
  });

  // The pin is the whole safety argument: trusting a file today must say nothing
  // about the file that arrives in tomorrow's pull request.
  it('does not trust the same source once its content changes', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    expect(new FileTrustStore(file).trusts('/repo/NOTES.md', `${TEXT}\nand one more line`)).toBe(
      false,
    );
  });

  it('does not trust the same content from a different source', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    expect(new FileTrustStore(file).trusts('/elsewhere/NOTES.md', TEXT)).toBe(false);
  });

  it('trusts nothing when the source is unknown, and nothing when the file is absent', () => {
    const file = trustFileWith({
      version: 1,
      entries: [{ source: '/repo/NOTES.md', sha256: trustDigest(TEXT), ruleIds: [], addedAt: 'x' }],
    });
    expect(new FileTrustStore(file).trusts('', TEXT)).toBe(false);
    expect(new FileTrustStore(join(tmpdir(), 'stroq-no-such-trust.json')).trusts('/a', TEXT)).toBe(
      false,
    );
  });
});
