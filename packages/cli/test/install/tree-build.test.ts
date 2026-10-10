import { describe, expect, it } from 'vitest';
import { buildTree, GITLINK_SHA256, treeDigest, treeStats } from '../../src/install/tree.js';
import {
  declared,
  entriesOf,
  fileEntry,
  gitlinkEntry,
  refusal,
  symlinkEntry,
  treeOf,
} from '../helpers/install-tree.js';

describe('buildTree', () => {
  // (`B` and `b` together would be a collision on a disk that ignores case, and are not a tree.)
  it('puts the entries in the order of the UTF-8 bytes of their paths', () => {
    const tree = buildTree([
      fileEntry('b', 'x'),
      fileEntry('\u00e9', 'x'),
      fileEntry('C', 'x'),
      fileEntry('z', 'x'),
      fileEntry('a b', 'x'),
      fileEntry('a.b', 'x'),
    ]);

    expect(tree.entries.map((e) => e.path)).toEqual(['C', 'a b', 'a.b', 'b', 'z', '\u00e9']);
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
