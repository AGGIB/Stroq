import { describe, expect, it } from 'vitest';
import {
  buildTree,
  fileDigestOf,
  GITLINK_SHA256,
  TreeError,
  treeDigest,
  treeStats,
  type TreeErrorCode,
} from '../../src/install/tree.js';
import { LIMITS, type TreeEntry } from '../../src/install/types.js';
import { escapeHtml, safe } from '../../src/replay/html.js';
import { neutralizeControls } from '../../src/terminal-safe.js';
import { entriesOf, fileEntry, gitlinkEntry, symlinkEntry, treeOf } from './helpers.js';

const digestOf = (entries: readonly TreeEntry[]): string => treeDigest({ entries });

/** The TreeError a call throws; any other outcome fails the test. */
function refusal(run: () => unknown): TreeError {
  try {
    run();
  } catch (error) {
    if (error instanceof TreeError) return error;
    throw error;
  }
  throw new Error('expected a TreeError, and nothing was thrown');
}

const codeOf = (entries: readonly TreeEntry[]): TreeErrorCode =>
  refusal(() => digestOf(entries)).code;

/** A file of a declared size, with no bytes behind it: a tree read back from a manifest looks like this. */
const declared = (path: string, size: number): TreeEntry => ({
  path,
  kind: 'file',
  exec: false,
  size,
  sha256: 'ab'.repeat(32),
});

describe('fileDigestOf', () => {
  // The two vectors every SHA-256 implementation is tested with (FIPS 180-4, NIST examples).
  it('is the SHA-256 of the raw bytes, in lower-case hex', () => {
    expect(fileDigestOf(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(fileDigestOf(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes bytes and not text: the UTF-8 of a letter is two bytes', () => {
    expect(fileDigestOf(Buffer.from('\u00e9', 'utf8'))).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
  });

  // A reader hands out windows onto one big buffer; the hash is of the window, not of the buffer.
  it('hashes the window of a view and not the buffer under it', () => {
    const whole = new TextEncoder().encode('xxabcxx');

    expect(fileDigestOf(whole.subarray(2, 5))).toBe(fileDigestOf(new TextEncoder().encode('abc')));
  });
});

describe('treeDigest refuses', () => {
  it('a path that appears twice', () => {
    expect(codeOf([fileEntry('a', 'x'), fileEntry('a', 'x')])).toBe('duplicate-path');
    expect(codeOf([fileEntry('a', 'x'), symlinkEntry('a', 't')])).toBe('duplicate-path');
  });

  // A quote is a legal character in a name, and the message must still be one line of text.
  it('and says which path appears twice, in quotes', () => {
    const error = refusal(() => digestOf([fileEntry('a"b', 'x'), fileEntry('a"b', 'y')]));

    expect(error.path).toBe('a"b');
    expect(error.message).toBe('path "a\\"b" appears twice');
  });

  it.each(['../x', '/abs', 'a\\b', '.git/config', 'a//b', '', 'C:/x', 'a\u0000b', 'CON.txt'])(
    'a path that is not safe to write: %j',
    (path) => {
      const error = refusal(() => digestOf([fileEntry(path, 'x')]));

      expect(error.code).toBe('bad-path');
      expect(error.path).toBe(path);
    },
  );

  it.each([undefined, null, 42, ['a'], {}])('an entry whose path is not text: %j', (path) => {
    const error = refusal(() =>
      digestOf([{ ...fileEntry('a', 'x'), path } as unknown as TreeEntry]),
    );

    expect(error.code).toBe('bad-path');
    expect(error.path).toBeNull();
    expect(error.message).toContain('no text for a path');
  });

  it('a file whose recorded hash is not the hash of its bytes', () => {
    const entry = { ...fileEntry('a', 'x'), sha256: fileDigestOf(new TextEncoder().encode('y')) };

    expect(codeOf([entry])).toBe('digest-mismatch');
  });

  it('a file whose bytes changed after the entry was made', () => {
    const bytes = new TextEncoder().encode('xyz');
    const entry = fileEntry('a', bytes);
    bytes[0] = 0x58;

    expect(codeOf([entry])).toBe('digest-mismatch');
  });

  it('a file whose recorded size is not the length of its bytes', () => {
    expect(codeOf([{ ...fileEntry('a', 'xyz'), size: 2 }])).toBe('size-mismatch');
    expect(codeOf([{ ...fileEntry('a', 'xyz'), size: 4 }])).toBe('size-mismatch');
  });

  it('a symlink whose recorded size or hash is not that of its target text', () => {
    const link = symlinkEntry('l', 'docs/\u00e9.md');

    expect(codeOf([{ ...link, size: 9 }])).toBe('size-mismatch');
    expect(codeOf([{ ...link, sha256: fileDigestOf(new TextEncoder().encode('other')) }])).toBe(
      'digest-mismatch',
    );
  });

  // A text is never fewer bytes than it has UTF-16 units, so this is wrong before it is encoded.
  it('a symlink whose target is longer than the size it records', () => {
    const error = refusal(() => digestOf([{ ...symlinkEntry('l', 'abcdef'), size: 3 }]));

    expect(error.code).toBe('size-mismatch');
    expect(error.message).toContain('the target is longer');
  });

  it('a gitlink that records a size or a hash', () => {
    expect(codeOf([{ ...gitlinkEntry('g'), size: 1 }])).toBe('size-mismatch');
    expect(codeOf([{ ...gitlinkEntry('g'), sha256: 'ab'.repeat(32) }])).toBe('digest-mismatch');
  });

  describe('an entry that is not an entry', () => {
    const file = fileEntry('a', 'x');
    const link = symlinkEntry('l', 't');
    const git = gitlinkEntry('g');

    it.each([
      ['an unknown kind', { ...file, kind: 'directory' }],
      ['a hard link', { ...file, kind: 'hardlink' }],
      ['an unknown kind on an entry with nothing else wrong', { ...git, kind: 'directory' }],
      ['an exec flag that is not a boolean', { ...file, exec: 1 }],
      ['an executable symlink', { ...link, exec: true }],
      ['an executable gitlink', { ...git, exec: true }],
      ['a negative size', { ...file, size: -1 }],
      ['a fractional size', { ...file, size: 0.5 }],
      ['a size that is not a number', { ...file, size: Number.NaN }],
      ['an infinite size', { ...file, size: Number.POSITIVE_INFINITY }],
      ['a size that is text', { ...file, size: '1' }],
      ['a hash in capitals', { ...file, sha256: file.sha256.toUpperCase() }],
      ['a hash that is too short', { ...file, sha256: file.sha256.slice(1) }],
      ['a hash that is not hex', { ...file, sha256: 'z'.repeat(64) }],
      ['a symlink that carries bytes', { ...link, bytes: new Uint8Array(1) }],
      ['a symlink with no target text', { ...link, target: '' }],
      ['a file that carries a target', { ...file, target: 'x' }],
      ['a gitlink that carries bytes', { ...git, bytes: new Uint8Array() }],
      ['a gitlink that carries a target', { ...git, target: 'x' }],
      ['bytes that are not bytes', { ...file, bytes: 'x' }],
      ['a target that is not text', { ...link, target: 5 }],
      ['a target that is not valid Unicode', { ...link, target: 'a\ud800' }],
      ['nothing at all', null],
      ['text instead of an entry', 'a'],
    ])('%s', (_what, entry) => {
      expect(codeOf([entry as unknown as TreeEntry])).toBe('bad-entry');
    });

    it('a tree that has no list of entries', () => {
      expect(refusal(() => treeDigest({} as never)).code).toBe('bad-entry');
      expect(refusal(() => treeDigest(null as never)).code).toBe('bad-entry');
    });
  });

  describe('a path that is both a file and a folder', () => {
    it.each([[['a', 'a/b']], [['a/b', 'a/b/c']], [['x/y', 'x/y/z/w', 'q']]])('%j', (paths) => {
      expect(codeOf(paths.map((p) => fileEntry(p, 'x')))).toBe('path-conflict');
    });

    it('and names the entry that is under the file, in quotes', () => {
      const error = refusal(() => digestOf([fileEntry('a"b', 'x'), fileEntry('a"b/c', 'x')]));

      expect(error.path).toBe('a"b/c');
      expect(error.message).toBe('entry "a\\"b/c": a folder of this path is also an entry');
    });

    it('a symlink or a gitlink that has something under it', () => {
      expect(codeOf([symlinkEntry('l', 't'), fileEntry('l/x', 'x')])).toBe('path-conflict');
      expect(codeOf([gitlinkEntry('g'), fileEntry('g/x', 'x')])).toBe('path-conflict');
    });

    it('but not names that merely begin alike', () => {
      expect(() =>
        digestOf([fileEntry('a', 'x'), fileEntry('ab', 'x'), fileEntry('a.txt', 'x')]),
      ).not.toThrow();
      expect(() => digestOf([fileEntry('a-b', 'x'), fileEntry('a/b', 'x')])).not.toThrow();
    });
  });

  describe('a tree over the limits', () => {
    it('with more entries than the limit', () => {
      const entries = Array.from({ length: LIMITS.maxEntries + 1 }, (_, i) =>
        gitlinkEntry(`g/${i}`),
      );

      expect(codeOf(entries)).toBe('limit');
    });

    it('but takes exactly the limit', () => {
      const entries = Array.from({ length: LIMITS.maxEntries }, (_, i) => gitlinkEntry(`g/${i}`));

      expect(digestOf(entries)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('with a file larger than the limit, by its record', () => {
      expect(codeOf([declared('big', LIMITS.maxFileBytes + 1)])).toBe('limit');
    });

    it('with a file larger than the limit, by its bytes', () => {
      const bytes = new Uint8Array(LIMITS.maxFileBytes + 1);

      expect(codeOf([fileEntry('big', bytes)])).toBe('limit');
    });

    it('but takes a file of exactly the limit', () => {
      const bytes = new Uint8Array(LIMITS.maxFileBytes);

      expect(digestOf([fileEntry('big', bytes)])).toMatch(/^[0-9a-f]{64}$/);
    });

    it('whose files together are larger than the limit', () => {
      const parts = LIMITS.maxExpanded / LIMITS.maxFileBytes;
      const exact = Array.from({ length: parts }, (_, i) => declared(`f${i}`, LIMITS.maxFileBytes));

      expect(() => digestOf(exact)).not.toThrow();
      expect(codeOf([...exact, declared('one-more', 1)])).toBe('limit');
    });

    // Hashing is the costly part; a tree is refused for its size before any of its bytes are hashed.
    it('without hashing what it will refuse', () => {
      const bytes = new Uint8Array(LIMITS.maxFileBytes);
      const lying = { ...fileEntry('f0', bytes), sha256: 'ab'.repeat(32) };
      const entries = [
        ...Array.from({ length: 4 }, (_, i) => declared(`d${i}`, LIMITS.maxFileBytes)),
        lying,
      ];

      expect(codeOf(entries)).toBe('limit');
    });
  });

  describe('with an error', () => {
    it('that is typed, and carries the path it is about', () => {
      const error = refusal(() => digestOf([fileEntry('a/../b', 'x')]));

      expect(error).toBeInstanceOf(TreeError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TreeError');
      expect(error.code).toBe('bad-path');
      expect(error.path).toBe('a/../b');
      expect(error.message).toContain('"a/../b"');
    });

    it('whose message cannot drive a terminal or a page, whatever the path was', () => {
      const hostile = 'a\u001b]52;c;ZXZpbA==\u0007\u202e\u200b\u009b';
      const error = refusal(() => digestOf([fileEntry(hostile, 'x')]));

      expect(error.path).toBe(hostile);
      expect(neutralizeControls(error.message)).toBe(error.message);
      expect(safe(error.message, 10_000)).toBe(escapeHtml(error.message));
    });

    it('that has no path when it is not about one', () => {
      expect(refusal(() => treeDigest(null as never)).path).toBeNull();
    });
  });
});

describe('buildTree', () => {
  it('puts the entries in the order of the UTF-8 bytes of their paths', () => {
    const tree = buildTree([
      fileEntry('b', 'x'),
      fileEntry('\u00e9', 'x'),
      fileEntry('B', 'x'),
      fileEntry('z', 'x'),
      fileEntry('a b', 'x'),
      fileEntry('a.b', 'x'),
    ]);

    expect(tree.entries.map((e) => e.path)).toEqual(['B', 'a b', 'a.b', 'b', 'z', '\u00e9']);
  });

  it('refuses what treeDigest refuses', () => {
    expect(refusal(() => buildTree([fileEntry('a', 'x'), fileEntry('a', 'y')])).code).toBe(
      'duplicate-path',
    );
    expect(refusal(() => buildTree([fileEntry('../a', 'x')])).code).toBe('bad-path');
    expect(refusal(() => buildTree([{ ...fileEntry('a', 'x'), size: 9 }])).code).toBe(
      'size-mismatch',
    );
    expect(refusal(() => buildTree([fileEntry('a', 'x'), fileEntry('a/b', 'x')])).code).toBe(
      'path-conflict',
    );
  });

  it('builds an empty tree', () => {
    expect(buildTree([]).entries).toEqual([]);
  });

  it('does not change, or keep hold of, the list or the entries it is given', () => {
    const entries = [fileEntry('b', 'x'), fileEntry('a', 'x')];
    const tree = buildTree(entries);

    expect(entries.map((e) => e.path)).toEqual(['b', 'a']);
    expect(tree.entries).not.toBe(entries);
    expect(tree.entries.some((entry) => entries.includes(entry))).toBe(false);
  });

  it('is frozen, all the way down to its entries', () => {
    const tree = buildTree(entriesOf({ a: 'x', l: { symlink: 't' } }));

    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(tree.entries)).toBe(true);
    expect(tree.entries.every((e) => Object.isFrozen(e))).toBe(true);
  });

  // The bytes are checked once, here, and are then the bytes that are hashed, analysed and written.
  // A reader that goes on to reuse its buffer must not be able to change them.
  it('takes its own copy of the bytes it was given', () => {
    const bytes = new TextEncoder().encode('original');
    const tree = buildTree([fileEntry('a', bytes)]);
    const before = treeDigest(tree);
    bytes.fill(0x21);

    expect(new TextDecoder().decode(tree.entries[0]?.bytes)).toBe('original');
    expect(treeDigest(tree)).toBe(before);
  });

  it('is a tree whose digest notices bytes that are changed after all', () => {
    const tree = buildTree([fileEntry('a', 'original')]);
    (tree.entries[0]?.bytes as Uint8Array)[0] = 0x21;

    expect(refusal(() => treeDigest(tree)).code).toBe('digest-mismatch');
  });

  it('keeps a symlink target and a gitlink as they were', () => {
    const tree = treeOf({ l: { symlink: 'docs/\u00e9.md' }, g: { gitlink: true } });
    const [git, link] = tree.entries;

    expect(link).toMatchObject({
      kind: 'symlink',
      target: 'docs/\u00e9.md',
      size: 10,
      exec: false,
    });
    expect(git).toMatchObject({ kind: 'gitlink', size: 0, sha256: GITLINK_SHA256 });
    expect(git).not.toHaveProperty('bytes');
    expect(git).not.toHaveProperty('target');
  });

  it('keeps an entry that has no bytes without bytes', () => {
    const [entry] = buildTree([declared('a', 3)]).entries;

    expect(entry).not.toHaveProperty('bytes');
    expect(entry).not.toHaveProperty('target');
  });
});

describe('treeStats', () => {
  it('counts the files and their bytes', () => {
    expect(treeStats(treeOf({ a: 'xx', 'b/c': 'yyy', empty: '' }))).toEqual({ files: 3, bytes: 5 });
  });

  it('does not count a symlink or a gitlink as a file', () => {
    expect(treeStats(treeOf({ a: 'xx', l: { symlink: 'a' }, g: { gitlink: true } }))).toEqual({
      files: 1,
      bytes: 2,
    });
  });

  it('is zero for an empty tree', () => {
    expect(treeStats({ entries: [] })).toEqual({ files: 0, bytes: 0 });
  });

  it('counts bytes, not characters', () => {
    expect(treeStats(treeOf({ a: '\u00e9\u{1f600}' }))).toEqual({ files: 1, bytes: 6 });
  });
});

describe('the helper that builds trees for tests', () => {
  it('records a symlink by the bytes of its target text and a gitlink as zeros', () => {
    expect(symlinkEntry('l', 'target')).toMatchObject({
      size: 6,
      sha256: '34a04005bcaf206eec990bd9637d9fdb6725e0a0c0d4aebf003f17f4c956eb5c',
    });
    expect(gitlinkEntry('g').sha256).toBe('0'.repeat(64));
    expect(GITLINK_SHA256).toBe('0'.repeat(64));
  });

  it('reads the three forms of the spec', () => {
    const tree = treeOf({
      'a/b.txt': 'text',
      'bin/run': { text: '#!/bin/sh', exec: true },
      link: { symlink: 'target' },
    });

    expect(tree.entries.map((e) => [e.path, e.kind, e.exec])).toEqual([
      ['a/b.txt', 'file', false],
      ['bin/run', 'file', true],
      ['link', 'symlink', false],
    ]);
    expect(tree.entries[0]?.sha256).toBe(
      '982d9e3eb996f559e633f4d194def3761d909f5a3b647d1a851fead67c32c9d1',
    );
  });
});
