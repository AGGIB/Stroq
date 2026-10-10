import { describe, expect, it } from 'vitest';
import { buildTree, fileDigestOf, treeDigest, treeManifest } from '../../src/install/tree.js';
import { LIMITS, type TreeEntry } from '../../src/install/types.js';
import { fileEntry, gitlinkEntry, symlinkEntry } from '../helpers/install-tree.js';

// An entry arrives from a reader as an object the caller still holds. If the checks read it, and the
// code that hashes, sorts and copies it reads it again, then what was checked and what is used are two
// reads of the same object, and anything that can answer differently the second time (a getter, a
// proxy, a reader that reuses its objects) makes a lie out of "the bytes that were checked are the
// bytes that are used". So each property is read once, and what is used is the copy that was made.

/**
 * `entry`, seen through a proxy that counts how often each property is read and, from the second read
 * of a property on, answers with the value `later` has for it (or the real one, if it has none).
 */
function shifting(entry: TreeEntry, later: Readonly<Record<string, unknown>> = {}) {
  const reads = new Map<string, number>();
  const source = entry as unknown as Record<string, unknown>;
  const proxy = new Proxy(source, {
    get(target, key) {
      if (typeof key !== 'string') return Reflect.get(target, key);
      const count = (reads.get(key) ?? 0) + 1;
      reads.set(key, count);
      return count > 1 && key in later ? later[key] : target[key];
    },
  });
  return { entry: proxy as unknown as TreeEntry, reads };
}

const SKIPPED = new Uint8Array([0x73, 0x6b, 0x69, 0x70]);

const CALLS: readonly (readonly [name: string, call: (entry: TreeEntry) => unknown])[] = [
  ['buildTree', (entry) => buildTree([entry])],
  ['treeDigest', (entry) => treeDigest({ entries: [entry] })],
  ['treeManifest', (entry) => treeManifest({ entries: [entry] })],
];

const KINDS: readonly (readonly [what: string, entry: TreeEntry])[] = [
  ['a file', fileEntry('a.txt', 'abc')],
  ['an executable file', fileEntry('bin/run', '#!/bin/sh', true)],
  ['a symlink', symlinkEntry('l', 'target')],
  ['a gitlink', gitlinkEntry('g')],
];

describe('an entry is read once', () => {
  describe.each(CALLS)('by %s', (_name, call) => {
    it.each(KINDS)('%s: no property is read a second time', (_what, entry) => {
      const probe = shifting(entry);

      call(probe.entry);

      expect(probe.reads.size).toBeGreaterThan(0);
      for (const [key, count] of probe.reads) {
        expect(count, key).toBe(1);
      }
    });
  });

  // The value that the second read would give is valid on its own, so nothing can refuse it: the only
  // way to tell is by what ends up in the tree.
  describe('and what is used is what was checked', () => {
    const plain = fileEntry('a.txt', 'abc');
    const link = symlinkEntry('l', 'target');

    it.each([
      ['path', plain, { path: 'other.txt' }],
      ['kind', plain, { kind: 'symlink' }],
      ['exec', plain, { exec: true }],
      ['size', plain, { size: 3_000 }],
      ['sha256', plain, { sha256: 'cd'.repeat(32) }],
      ['bytes', plain, { bytes: new TextEncoder().encode('xyz') }],
      ['target', link, { target: 'elsewhere' }],
    ])('%s', (_key, entry, later) => {
      const probe = shifting(entry, later);
      const tree = buildTree([probe.entry]);

      expect(tree.entries).toEqual([entry]);
      expect(treeManifest(tree)).toBe(treeManifest({ entries: [entry] }));
      // The digest of the tree that was built is true: the bytes in it are the bytes that were hashed.
      expect(treeDigest(tree)).toBe(treeDigest({ entries: [entry] }));
    });

    it('a path that would be refused if it were read a second time', () => {
      const probe = shifting(plain, { path: '../escape' });
      const tree = buildTree([probe.entry]);

      expect(tree.entries.map((e) => e.path)).toEqual(['a.txt']);
    });

    it('a hash and a size that would be wrong if they were read a second time', () => {
      const probe = shifting(plain, { size: 1, sha256: fileDigestOf(SKIPPED) });
      const [kept] = buildTree([probe.entry]).entries;

      expect(kept?.size).toBe(3);
      expect(kept?.sha256).toBe(plain.sha256);
    });

    it('the digest of an entry that is not built into a tree, too', () => {
      const probe = shifting(plain, { path: 'other.txt', exec: true, size: 9 });

      expect(treeDigest({ entries: [probe.entry] })).toBe(treeDigest({ entries: [plain] }));
    });
  });

  it('a tree whose entries are not the caller objects, and cannot be changed through them', () => {
    const entry: { -readonly [K in keyof TreeEntry]: TreeEntry[K] } = {
      ...fileEntry('a.txt', 'abc'),
    };
    const tree = buildTree([entry]);
    entry.path = 'changed.txt';
    entry.exec = true;

    expect(tree.entries[0]?.path).toBe('a.txt');
    expect(tree.entries[0]?.exec).toBe(false);
    expect(tree.entries[0]).not.toBe(entry);
    expect(Object.isFrozen(tree.entries[0])).toBe(true);
  });

  // Reading an entry can run code of the caller's (a getter), and that code may reach the buffers of
  // the entries read before it. The bytes are copied before they are hashed, so the ones in the tree
  // are the ones that were hashed.
  it('bytes that another entry changes while the list is being read', () => {
    const bytes = new TextEncoder().encode('abc');
    const meddler = new Proxy(fileEntry('b.txt', 'x'), {
      get(target, key) {
        bytes.fill(0x21);
        return Reflect.get(target, key);
      },
    });

    const tree = buildTree([fileEntry('a.txt', bytes), meddler]);

    expect(new TextDecoder().decode(tree.entries[0]?.bytes)).toBe('abc');
    expect(treeDigest(tree)).toMatch(/^[0-9a-f]{64}$/);
  });

  // `length` is read once and bounds the loop, so a list that grows as it is read cannot get past
  // the limit on the number of entries.
  it('the length of the list of entries', () => {
    const only = fileEntry('a.txt', 'abc');
    let reads = 0;
    const list = new Proxy([only], {
      get(target, key) {
        if (key === 'length') {
          reads += 1;
          return reads === 1 ? 1 : LIMITS.maxEntries * 1_000;
        }
        return Reflect.get(target, key);
      },
    });

    expect(treeDigest({ entries: list })).toBe(treeDigest({ entries: [only] }));
    expect(reads).toBeLessThanOrEqual(1);
  });
});
