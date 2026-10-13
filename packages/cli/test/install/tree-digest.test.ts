import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildTree, treeDigest, treeManifest } from '../../src/install/tree.js';
import type { Tree, TreeEntry } from '../../src/install/types.js';
import { entriesOf, treeOf } from '../helpers/install-tree.js';

// The digest is a promise to people who are not here yet: an author quotes it in a README, a lock
// file pins it, and each of them must get the same answer on any machine, today and in two years.
// So nothing in this file computes a digest with the code under test. Every hex string below was
// reproduced by a Python program that shares no code with the module and sorts and hashes by the
// format in the spec alone (`hashlib`), and the first two were also checked with `shasum -a 256`. The
// spec prints the text that the twelve-entry vector hashes, so that a reader who has not got this
// module can hash it too. The tests touch no filesystem and read no clock, so the same file is meant
// to run on Linux, macOS and Windows and to give the same digests; it has so far been run on macOS
// only, because no CI has run on this branch yet.

const FULL_WIDTH_Z = '\uff5a.txt'; // one BMP character: UTF-8 EF BD 9A
const GRINNING_FACE = '\u{1f600}.txt'; // one astral character: UTF-8 F0 9F 98 80

/** The tree of vector (c), with its entries listed in no order that helps. */
function mixed(): Tree {
  return treeOf({
    [GRINNING_FACE]: 'smile',
    lnk: { symlink: 'docs/\u00e9.md' },
    'docs/\u00e9.md': 'caf\u00e9',
    'a.txt': 'a',
    'vendor/sub': { gitlink: true },
    'B.txt': 'B',
    [FULL_WIDTH_Z]: 'fw',
    'bin/run': { text: '#!/bin/sh\necho hi\n', exec: true },
    '_private.txt': '',
    'Z.txt': 'Z\n',
    'docs/z.md': 'z',
    'a b.txt': 'space',
  });
}

const MIXED_PATHS_IN_BYTE_ORDER = [
  'B.txt',
  'Z.txt',
  '_private.txt',
  'a b.txt',
  'a.txt',
  'bin/run',
  'docs/z.md',
  'docs/\u00e9.md',
  'lnk',
  'vendor/sub',
  FULL_WIDTH_Z,
  GRINNING_FACE,
];

const MIXED_MANIFEST = [
  'stroq-tree/1',
  'f 0 1 df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c B.txt',
  'f 0 2 ec39b67830c0c34d71b0b6bf1d1c424eb7caab9222eb401fdaef044cf2145e9b Z.txt',
  'f 0 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 _private.txt',
  'f 0 5 3f49dbbfe051cb20cc038923424fedf8d18307cc805e1520e4168e9360e2eb38 a b.txt',
  'f 0 1 ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb a.txt',
  'f 1 18 299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba bin/run',
  'f 0 1 594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06 docs/z.md',
  'f 0 5 850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e docs/\u00e9.md',
  'l 0 10 c13070e42c92f74c8791d1431dd7bc370763659708e5269e492305297a7d1f40 lnk',
  `g 0 0 ${'0'.repeat(64)} vendor/sub`,
  `f 0 2 07f7ab476bc3a83fad639d34a012cb4a5f859441f0d24c11627ca96696839012 ${FULL_WIDTH_Z}`,
  `f 0 5 fa1eadc4c6995667412681c69ce33adfc9302a2965f521c40908549e670e2e4e ${GRINNING_FACE}`,
  '',
].join('\n');

const GOLDEN = {
  empty: 'a55df2b9db34f2f996df306efa9d7e40fe435756d35c259054f02079a2db5af9',
  oneFile: '46dbb1de69c273f8996ac30dfa1d2fc6ab83ea080e40a4e15d4be87e55ab5223',
  mixed: '40d01f91f80f781704e8e0b4945c1ee67cce432b5356ab57d8c7819febf50b7a',
  oneByte: '7d042819a1f11e26d92db75b134f39f226a4835e65119c2ab6741c48bdf12744',
  execBit: '17e02ce0229b30238cf1a92195f398f8be0dc90db13d58bb9b9acecde744216f',
  renamed: '3b6500146585ded6e8a23b06a040fbbf512a4ed987ed265b7b014146e4733335',
  added: '258cba9d4db62ab66ae0142051391bc5f05fb48d2f612ef91af406579208a0fd',
  removed: '2eaea6e88545eb6525c50cf71969ece606c2e6895968ab40ea343a1964cba4fc',
  targetChanged: 'fcee979ed03f016ca2d62fcd82d1743f7ccb008a40aa4db61e6cdcb52d9bae8e',
  linkBecomesFile: 'a27f3158b3210305a7a265f99d952e6d1d9bb9b4cc3dbfca952b45acb6472d91',
} as const;

/** The vectors of (e), (f) and (g), which are not changes to the mixed tree and so are kept apart from it. */
const GOLDEN_ORDER = {
  wholePath: '314b81cc68ba1e227418ed0c76e401aa609bd9a18e499585b3ebfbad369404c3',
  /** The same three lines, in the order of a sort that goes folder by folder. Not a digest of anything real. */
  folderByFolder: '43b1c9e7d2cec50e79ae9fe3d5fe46b87a1c7f3685e5a8281b9edeb68bd8ef52',
  composed: 'b30ff40ed2b391f580ed00d7c320ef2bdc037dec5738387202c9b6cb7f50ac59',
  decomposed: 'ed486ccbd1dcc27357665f5ac31cdeb80239c5275170dc6c83cc9d697b9387f4',
  /** (g) A decomposed name, and the composed name that it is the start of once composed. */
  startsComposed: '226a608853e0118bb823e1f45d505b3d3c452a0ccc0db40d9724df5c475b5e61',
  /** The same two lines, in the order of a sort by the NFC or the NFD form of the path. Not a digest of anything real. */
  startsComposedSwapped: '6ab5845d9d08fcf917c588bd3e76a75fab0274fbe886b23e13f997454bbd67d4',
  /** (g) A decomposed `a` with an accent, and `b`. */
  accentBeforeB: '9a027587f0ff3dc6289a20b8b71534399367ac27854accc23caaaadcabc87ec4',
  /** The same two lines, in the order of a sort by the NFC form of the path. Not a digest of anything real. */
  accentBeforeBSwapped: '2bec8af129a378613e258df664ab7a0697affa1575b03a86afcda633c37910db',
} as const;

const WHOLE_PATH_MANIFEST = [
  'stroq-tree/1',
  'f 0 2 73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac lib-x',
  'f 0 3 b541871ddf2562ec0d416dfaf9d40743ba2cf40aa60e251665cfb8088bf8bd5b lib.js',
  'f 0 2 87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7 lib/a.js',
  '',
].join('\n');

const sha256OfText = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** The entries of vector (c), mixed up, for the variants below to bend one of. */
const mixedEntries = (): TreeEntry[] => [...mixed().entries].reverse();

/** The mixed tree with the entries `change` is given replaced or added. */
function mixedWith(change: (entries: TreeEntry[]) => TreeEntry[]): string {
  return treeDigest({ entries: change(mixedEntries()) });
}

const without = (entries: readonly TreeEntry[], path: string): TreeEntry[] =>
  entries.filter((e) => e.path !== path);

describe('stroq-tree/1 golden vectors', () => {
  it('(a) the empty tree is the hash of the header line alone', () => {
    expect(treeDigest({ entries: [] })).toBe(GOLDEN.empty);
    expect(treeManifest({ entries: [] })).toBe('stroq-tree/1\n');
  });

  it('(b) one file', () => {
    const tree = treeOf({ 'SKILL.md': '# demo\n' });

    expect(treeManifest(tree)).toBe(
      'stroq-tree/1\nf 0 7 bc70e26f40b8816eb177813dda1f5f529a27a4641d45aa19cae2348a8c6a5fe9 SKILL.md\n',
    );
    expect(treeDigest(tree)).toBe(GOLDEN.oneFile);
  });

  describe('(c) a mixed tree', () => {
    it('is written one line per entry, in the order of the UTF-8 bytes of the paths', () => {
      expect(treeManifest(mixed())).toBe(MIXED_MANIFEST);
    });

    it('has the digest that was worked out without this code', () => {
      expect(treeDigest(mixed())).toBe(GOLDEN.mixed);
    });

    it('records the executable bit, a symlink by its target text, and a gitlink as zeros', () => {
      const lines = MIXED_MANIFEST.split('\n');

      expect(lines.find((l) => l.endsWith(' bin/run'))?.startsWith('f 1 18 ')).toBe(true);
      expect(lines.find((l) => l.endsWith(' lnk'))?.startsWith('l 0 10 ')).toBe(true);
      expect(lines.find((l) => l.endsWith(' vendor/sub'))).toBe(
        `g 0 0 ${'0'.repeat(64)} vendor/sub`,
      );
    });

    // The vector is only worth having while the sort it pins is not the one an engine does by
    // default: UTF-16 code units put a character outside the BMP before U+FF5A, and the bytes put
    // it after. (`localeCompare` differs too, but how much depends on the locale of the machine,
    // so it is not asserted.)
    it('is a vector in which the default sort and the byte sort disagree', () => {
      expect([...MIXED_PATHS_IN_BYTE_ORDER].sort()).not.toEqual(MIXED_PATHS_IN_BYTE_ORDER);
      expect(MIXED_PATHS_IN_BYTE_ORDER.indexOf(FULL_WIDTH_Z)).toBeLessThan(
        MIXED_PATHS_IN_BYTE_ORDER.indexOf(GRINNING_FACE),
      );
    });

    it('counts the size of a file in bytes: "caf\u00e9" is four letters and five bytes', () => {
      expect(MIXED_MANIFEST).toContain(' 5 850f7dc4');
    });
  });

  describe('(d) what changes the digest, and what does not', () => {
    it('does not change with the order the entries come in', () => {
      const entries = mixedEntries();
      const rotated = [...entries.slice(5), ...entries.slice(0, 5)];

      expect(treeDigest({ entries })).toBe(GOLDEN.mixed);
      expect(treeDigest({ entries: rotated })).toBe(GOLDEN.mixed);
      expect(treeDigest(buildTree(entries))).toBe(GOLDEN.mixed);
    });

    it('does not change with any order at all', () => {
      const entries = mixedEntries();

      fc.assert(
        fc.property(fc.shuffledSubarray(entries, { minLength: entries.length }), (shuffled) => {
          expect(treeDigest({ entries: shuffled })).toBe(GOLDEN.mixed);
        }),
        { numRuns: 200 },
      );
    });

    it('does not depend on whether the bytes are there: it is about what was recorded', () => {
      const stripped = mixedEntries().map(({ bytes: _bytes, ...rest }) => rest);

      expect(treeDigest({ entries: stripped })).toBe(GOLDEN.mixed);
    });

    it('nor on whether the target text of a symlink is there', () => {
      const stripped = mixedEntries().map(({ bytes: _bytes, target: _target, ...rest }) => rest);

      expect(stripped.some((entry) => entry.kind === 'symlink')).toBe(true);
      expect(treeDigest({ entries: stripped })).toBe(GOLDEN.mixed);
    });

    it('changes when one byte of one file changes', () => {
      const entries = entriesOf({ 'a.txt': 'b' });
      const digest = mixedWith((all) => [...without(all, 'a.txt'), ...entries]);

      expect(digest).toBe(GOLDEN.oneByte);
    });

    it('changes when the executable bit changes', () => {
      const digest = mixedWith((all) => [
        ...without(all, 'a.txt'),
        ...entriesOf({ 'a.txt': { text: 'a', exec: true } }),
      ]);

      expect(digest).toBe(GOLDEN.execBit);
    });

    it('changes when a path changes', () => {
      const digest = mixedWith((all) => [
        ...without(all, 'a.txt'),
        ...entriesOf({ 'a1.txt': 'a' }),
      ]);

      expect(digest).toBe(GOLDEN.renamed);
    });

    it('changes when an entry is added', () => {
      const digest = mixedWith((all) => [...all, ...entriesOf({ 'extra.txt': 'x' })]);

      expect(digest).toBe(GOLDEN.added);
    });

    it('changes when an entry is removed', () => {
      expect(mixedWith((all) => without(all, 'B.txt'))).toBe(GOLDEN.removed);
    });

    it('changes when the target of a symlink changes', () => {
      const digest = mixedWith((all) => [
        ...without(all, 'lnk'),
        ...entriesOf({ lnk: { symlink: 'docs/z.md' } }),
      ]);

      expect(digest).toBe(GOLDEN.targetChanged);
    });

    it('changes when a symlink is replaced by a file with the same text', () => {
      const digest = mixedWith((all) => [
        ...without(all, 'lnk'),
        ...entriesOf({ lnk: 'docs/\u00e9.md' }),
      ]);

      expect(digest).toBe(GOLDEN.linkBecomesFile);
    });

    it('is a different digest for every one of these changes', () => {
      const digests = Object.values(GOLDEN);

      expect(new Set(digests).size).toBe(digests.length);
    });
  });

  // Two rules that the format depends on and that no other vector pins: what the order is the order
  // of, and what is done to a spelling before it is hashed.
  describe('(e) the order is that of the bytes of the whole path string', () => {
    // `-` is 0x2d and `.` is 0x2e, both below `/` (0x2f). Compared as whole strings, `lib-x` and
    // `lib.js` come before `lib/a.js`. A sort that goes folder by folder compares the name `lib`
    // with `lib-x` and `lib.js` first, finds it shorter, and puts everything in `lib/` ahead of them.
    const tree = () => treeOf({ 'lib/a.js': 'a\n', 'lib.js': 'js\n', 'lib-x': 'x\n' });

    it('puts a name that continues with a character below the slash before the folder', () => {
      expect(treeManifest(tree())).toBe(WHOLE_PATH_MANIFEST);
    });

    it('has the digest that was worked out without this code', () => {
      expect(treeDigest(tree())).toBe(GOLDEN_ORDER.wholePath);
    });

    it('is not the digest of a sort that goes folder by folder, which a reader could be written to do', () => {
      const [header, dash, dot, folder] = WHOLE_PATH_MANIFEST.split('\n');
      const folderByFolder = [header, folder, dash, dot, ''].join('\n');

      expect(sha256OfText(folderByFolder)).toBe(GOLDEN_ORDER.folderByFolder);
      expect(treeDigest(tree())).not.toBe(GOLDEN_ORDER.folderByFolder);
    });

    it('does not depend on the order the entries are given in', () => {
      const entries = entriesOf({ 'lib/a.js': 'a\n', 'lib.js': 'js\n', 'lib-x': 'x\n' });

      for (const order of [entries, [...entries].reverse(), [entries[1], entries[2], entries[0]]]) {
        expect(treeDigest({ entries: order as TreeEntry[] })).toBe(GOLDEN_ORDER.wholePath);
      }
    });
  });

  describe('(f) a path is hashed as it is spelled, with no Unicode normalisation', () => {
    // The same name twice: caf, then an e with an acute accent written as one character (NFC, UTF-8
    // c3 a9) or as an e and a combining accent (NFD, UTF-8 65 cc 81). Two trees, because a tree that
    // holds both is refused (tree-collisions.test.ts).
    const composed = () => treeOf({ 'caf\u00e9.txt': 'x\n' });
    const decomposed = () => treeOf({ 'cafe\u0301.txt': 'x\n' });

    it('writes the bytes of each spelling, as they were given', () => {
      const bytesOf = (tree: Tree) => Buffer.from(treeManifest(tree), 'utf8');

      expect(bytesOf(composed()).includes(Buffer.from('636166c3a92e747874', 'hex'))).toBe(true);
      expect(bytesOf(decomposed()).includes(Buffer.from('63616665cc812e747874', 'hex'))).toBe(true);
    });

    it('gives each spelling the digest that was worked out without this code', () => {
      expect(treeDigest(composed())).toBe(GOLDEN_ORDER.composed);
      expect(treeDigest(decomposed())).toBe(GOLDEN_ORDER.decomposed);
    });

    it('gives the two spellings two digests, though they are one name once normalised', () => {
      expect('caf\u00e9.txt'.normalize('NFD')).toBe('cafe\u0301.txt');
      expect(GOLDEN_ORDER.composed).not.toBe(GOLDEN_ORDER.decomposed);
      expect(treeDigest(composed())).not.toBe(treeDigest(decomposed()));
    });
  });

  // Rule 2 says a path is hashed as spelled, and the order is of the same bytes. The vectors of (f) have
  // one name each, so they would pass a reader that sorts by the NFC form of a path (or the NFD form)
  // and hashes the path as spelled. These two trees do not: in each, the name that comes first by the
  // bytes as spelled comes second by a normalised form.
  describe('(g) the order is that of the bytes as spelled, whatever a normalised form would say', () => {
    const X_HASH = sha256OfText('x\n');
    const manifestOf = (names: readonly string[]): string =>
      ['stroq-tree/1', ...names.map((name) => `f 0 2 ${X_HASH} ${name}`), ''].join('\n');
    const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');

    const CASES = [
      {
        what: 'a decomposed name, and the composed name it is the start of once composed',
        names: ['e\u0301a', '\u00e9'],
        digest: GOLDEN_ORDER.startsComposed,
        swapped: GOLDEN_ORDER.startsComposedSwapped,
      },
      {
        what: 'a decomposed a with an accent, and b',
        names: ['a\u0301.txt', 'b.txt'],
        digest: GOLDEN_ORDER.accentBeforeB,
        swapped: GOLDEN_ORDER.accentBeforeBSwapped,
      },
    ] as const;

    describe.each(CASES)('$what', ({ names, digest, swapped }) => {
      const tree = (): Tree => treeOf(Object.fromEntries(names.map((name) => [name, 'x\n'])));

      it('is a pair that a sort by a normalised form puts the other way round', () => {
        const [first, second] = names;

        expect(Buffer.compare(bytes(first), bytes(second))).toBeLessThan(0);
        expect(
          Buffer.compare(bytes(first.normalize('NFC')), bytes(second.normalize('NFC'))),
        ).toBeGreaterThan(0);
      });

      it('lists the names in the order of the bytes as spelled', () => {
        expect(treeManifest(tree())).toBe(manifestOf(names));
      });

      it('has the digest that was worked out without this code', () => {
        expect(treeDigest(tree())).toBe(digest);
      });

      it('is not the digest of the lines in the other order, which a reader could be written to give', () => {
        expect(sha256OfText(manifestOf([...names].reverse()))).toBe(swapped);
        expect(treeDigest(tree())).not.toBe(swapped);
      });
    });
  });
});

// The spec is where an author of another reader looks, so what it prints has to be what is pinned here:
// the text that the twelve-entry vector hashes, and every digest of this file.
describe('the spec prints the vectors that are pinned here', () => {
  const spec = readFileSync(
    new URL('../../../../docs/superpowers/specs/2026-10-10-safe-install.md', import.meta.url),
    'utf8',
  );

  it('prints the text that the twelve-entry vector hashes', () => {
    expect(spec).toContain(MIXED_MANIFEST);
    expect(sha256OfText(MIXED_MANIFEST)).toBe(GOLDEN.mixed);
  });

  it.each([...Object.entries(GOLDEN), ...Object.entries(GOLDEN_ORDER)])(
    'prints the digest of %s',
    (_name, digest) => {
      expect(spec).toContain(digest);
    },
  );
});
