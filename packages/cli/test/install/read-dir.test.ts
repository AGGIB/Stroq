import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDirTree } from '../../src/install/read-dir.js';
import { treeDigest } from '../../src/install/tree.js';
import type { Tree, TreeEntry } from '../../src/install/types.js';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';
import { fileEntry, symlinkEntry, treeOf } from '../helpers/install-tree.js';

afterEach(removeTempRoots);

const isWindows = process.platform === 'win32';
const entryAt = (tree: Tree, path: string): TreeEntry | undefined =>
  tree.entries.find((entry) => entry.path === path);
const pathsOf = (tree: Tree): string[] => tree.entries.map((entry) => entry.path);

describe('readDirTree: a plain folder', () => {
  it('reads each file with its bytes, its size and the hash of those bytes', async () => {
    const root = tempRoot();
    writeFiles(root, { 'SKILL.md': '# demo\n', 'lib/a.js': 'x = 1\n' });

    const { tree, blindSpots } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['SKILL.md', 'lib/a.js']);
    const skill = entryAt(tree, 'SKILL.md');
    expect(skill?.kind).toBe('file');
    expect(skill?.size).toBe(7);
    expect(Buffer.from(skill?.bytes ?? []).toString('utf8')).toBe('# demo\n');
    expect(blindSpots.filter((spot) => !spot.includes('executable'))).toEqual([]);
  });

  it('has the digest the contract publishes for a folder of one small file', async () => {
    const root = tempRoot();
    writeFiles(root, { 'SKILL.md': '# demo\n' });

    const { tree } = await readDirTree(root);

    expect(treeDigest(tree)).toBe(
      '46dbb1de69c273f8996ac30dfa1d2fc6ab83ea080e40a4e15d4be87e55ab5223',
    );
  });

  it('has the same digest as the same files built in memory, in any order they were written', async () => {
    const files: Record<string, string> = {
      'b/two.txt': '2',
      'a.txt': '1',
      'lib-x': 'x\n',
      'lib.js': 'js\n',
      'lib/a.js': 'a\n',
      'caf\u00e9.txt': 'accent',
    };
    const forward = tempRoot('forward');
    const backward = tempRoot('backward');
    writeFiles(forward, files);
    writeFiles(backward, Object.fromEntries(Object.entries(files).reverse()));

    const first = await readDirTree(forward);
    const second = await readDirTree(backward);

    expect(treeDigest(first.tree)).toBe(treeDigest(second.tree));
    expect(treeDigest(first.tree)).toBe(treeDigest(treeOf(files)));
  });

  it('makes no entry of an empty folder', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'empty', 'deeper'), { recursive: true });
    writeFiles(root, { 'keep.txt': 'k' });

    const { tree } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['keep.txt']);
  });

  it('reads an empty folder as an empty tree', async () => {
    const root = tempRoot();

    const { tree } = await readDirTree(root);

    expect(tree.entries).toEqual([]);
    expect(treeDigest(tree)).toBe(
      'a55df2b9db34f2f996df306efa9d7e40fe435756d35c259054f02079a2db5af9',
    );
  });

  it('reads a file of no bytes and a file of every byte value', async () => {
    const root = tempRoot();
    const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
    writeFiles(root, { 'empty.txt': '', 'all.bin': everyByte });

    const { tree } = await readDirTree(root);

    expect(entryAt(tree, 'empty.txt')?.size).toBe(0);
    expect(Array.from(entryAt(tree, 'all.bin')?.bytes ?? [])).toEqual(Array.from(everyByte));
  });

  it('returns a frozen tree and a sorted list of blind spots without repeats', async () => {
    const root = tempRoot();
    writeFiles(root, {
      'a/node_modules/x.js': 'x',
      'b/node_modules/y.js': 'y',
      '.git/config': '[core]',
      'c/.git': 'gitdir: ../.git/modules/c',
      'ok.txt': 'ok',
    });

    const { tree, blindSpots } = await readDirTree(root);

    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(tree.entries)).toBe(true);
    expect(blindSpots).toEqual([...blindSpots].sort());
    expect(new Set(blindSpots).size).toBe(blindSpots.length);
  });
});

describe.skipIf(isWindows)('readDirTree: the path it is given', () => {
  it('resolves it once, so a link to the folder reads the folder', async () => {
    const root = tempRoot();
    writeFiles(root, { 'real/SKILL.md': '# demo\n' });
    symlinkSync(join(root, 'real'), join(root, 'alias'));

    const { tree } = await readDirTree(join(root, 'alias'));

    expect(pathsOf(tree)).toEqual(['SKILL.md']);
  });
});

describe('readDirTree: links are recorded and never followed', () => {
  const linkTest = it.skipIf(isWindows);

  linkTest('records a link as a symlink entry with its target text', async () => {
    const root = tempRoot();
    writeFiles(root, { 'docs/real.md': 'real' });
    symlinkSync('docs/real.md', join(root, 'alias.md'));

    const { tree } = await readDirTree(root);

    const link = entryAt(tree, 'alias.md');
    expect(link?.kind).toBe('symlink');
    expect(link?.target).toBe('docs/real.md');
    expect(link?.bytes).toBeUndefined();
    expect(treeDigest(tree)).toBe(
      treeDigest(treeOf({ 'docs/real.md': 'real', 'alias.md': { symlink: 'docs/real.md' } })),
    );
  });

  linkTest('does not read what a link to a file outside the folder points at', async () => {
    const outside = tempRoot('outside');
    writeFiles(outside, { 'secret.txt': 'TOP-SECRET-CONTENT' });
    const root = tempRoot();
    writeFiles(root, { 'ok.txt': 'ok' });
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'));

    const { tree } = await readDirTree(root);

    const link = entryAt(tree, 'leak.txt');
    expect(link?.kind).toBe('symlink');
    const everything = tree.entries.map((entry) => Buffer.from(entry.bytes ?? []).toString());
    expect(everything.join('')).not.toContain('TOP-SECRET-CONTENT');
  });

  linkTest('does not enter a link to a folder', async () => {
    const outside = tempRoot('outside');
    writeFiles(outside, { 'inside.txt': 'from outside' });
    const root = tempRoot();
    symlinkSync(outside, join(root, 'door'));

    const { tree } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['door']);
    expect(entryAt(tree, 'door')?.kind).toBe('symlink');
  });

  linkTest(
    'ends on two links that point at each other, and on a link to its own folder',
    async () => {
      const root = tempRoot();
      symlinkSync('b', join(root, 'a'));
      symlinkSync('a', join(root, 'b'));
      symlinkSync('.', join(root, 'self'));
      symlinkSync('..', join(root, 'up'));

      const { tree } = await readDirTree(root);

      expect(pathsOf(tree)).toEqual(['a', 'b', 'self', 'up']);
      expect(tree.entries.every((entry) => entry.kind === 'symlink')).toBe(true);
    },
  );

  linkTest('records a link that points at nothing', async () => {
    const root = tempRoot();
    symlinkSync('does-not-exist', join(root, 'dangling'));

    const { tree } = await readDirTree(root);

    expect(entryAt(tree, 'dangling')?.target).toBe('does-not-exist');
  });

  linkTest('hashes the target text of a link as the contract says', async () => {
    const root = tempRoot();
    symlinkSync('docs/\u00e9.md', join(root, 'lnk'));

    const { tree } = await readDirTree(root);

    const expected = symlinkEntry('lnk', 'docs/\u00e9.md');
    expect(entryAt(tree, 'lnk')?.size).toBe(expected.size);
    expect(entryAt(tree, 'lnk')?.sha256).toBe(expected.sha256);
  });
});

describe('readDirTree: the executable bit', () => {
  const posixTest = it.skipIf(isWindows);

  posixTest('records the owner-execute bit and puts it in the digest', async () => {
    const plain = tempRoot('plain');
    const program = tempRoot('program');
    writeFiles(plain, { 'run.sh': '#!/bin/sh\necho hi\n' });
    writeFiles(program, { 'run.sh': '#!/bin/sh\necho hi\n' });
    chmodSync(join(plain, 'run.sh'), 0o644);
    chmodSync(join(program, 'run.sh'), 0o755);

    const first = await readDirTree(plain);
    const second = await readDirTree(program);

    expect(entryAt(first.tree, 'run.sh')?.exec).toBe(false);
    expect(entryAt(second.tree, 'run.sh')?.exec).toBe(true);
    expect(treeDigest(first.tree)).not.toBe(treeDigest(second.tree));
    expect(treeDigest(second.tree)).toBe(
      treeDigest(buildSingle(fileEntry('run.sh', '#!/bin/sh\necho hi\n', true))),
    );
  });

  posixTest('does not count a group or other execute bit as executable', async () => {
    const root = tempRoot();
    writeFiles(root, { 'g.sh': 'x', 'o.sh': 'x' });
    chmodSync(join(root, 'g.sh'), 0o654);
    chmodSync(join(root, 'o.sh'), 0o645);

    const { tree } = await readDirTree(root);

    expect(entryAt(tree, 'g.sh')?.exec).toBe(false);
    expect(entryAt(tree, 'o.sh')?.exec).toBe(false);
  });

  posixTest('says nothing of the executable bit where the platform has one', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'a' });

    const { blindSpots } = await readDirTree(root);

    expect(blindSpots).not.toContain('executable bit not available on this platform');
  });

  it('records no executable bit, and says so, where the platform has none', async () => {
    const root = tempRoot();
    writeFiles(root, { 'run.sh': '#!/bin/sh\n' });
    if (!isWindows) chmodSync(join(root, 'run.sh'), 0o755);

    const { tree, blindSpots } = await readDirTree(root, { platform: 'win32' });

    expect(entryAt(tree, 'run.sh')?.exec).toBe(false);
    expect(blindSpots).toContain('executable bit not available on this platform');
  });
});

describe('readDirTree: what it leaves out', () => {
  it('does not enter a .git folder, records nothing of it, and says so', async () => {
    const root = tempRoot();
    writeFiles(root, { '.git/config': '[core]\n', '.git/hooks/pre-commit': 'x', 'ok.txt': 'ok' });

    const { tree, blindSpots } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['ok.txt']);
    expect(blindSpots).toContain('a .git entry was left out');
  });

  it('leaves out the .git file a submodule has, wherever it is', async () => {
    const root = tempRoot();
    writeFiles(root, {
      'vendor/sub/.git': 'gitdir: ../../.git/modules/sub\n',
      'vendor/sub/a.js': '1',
    });

    const { tree, blindSpots } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['vendor/sub/a.js']);
    expect(blindSpots).toContain('a .git entry was left out');
  });

  it('leaves out a .git written in capitals too, which a disk that ignores case opens as .git', async () => {
    const root = tempRoot();
    writeFiles(root, { '.GIT/config': 'x', 'ok.txt': 'ok' });

    const { tree, blindSpots } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['ok.txt']);
    expect(blindSpots).toContain('a .git entry was left out');
  });

  it('leaves out node_modules at any depth and says how many it passed', async () => {
    const root = tempRoot();
    writeFiles(root, {
      'node_modules/dep/index.js': 'x',
      'pkg/node_modules/dep/index.js': 'y',
      'pkg/main.js': 'm',
    });

    const { tree, blindSpots } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['pkg/main.js']);
    const spot = blindSpots.find((text) => text.includes('node_modules'));
    expect(spot).toBeDefined();
    expect(spot).toContain('2');
  });

  it('reports no .git and no node_modules blind spot for a folder that has neither', async () => {
    const root = tempRoot();
    writeFiles(root, { 'a.txt': 'a' });

    const { blindSpots } = await readDirTree(root);

    expect(blindSpots.some((text) => text.includes('.git') || text.includes('node_modules'))).toBe(
      false,
    );
  });

  it('still reads .gitignore, .github and .gitattributes, which are ordinary files', async () => {
    const root = tempRoot();
    writeFiles(root, {
      '.gitignore': 'dist\n',
      '.gitattributes': '* text=auto\n',
      '.github/workflows/ci.yml': 'on: push\n',
    });

    const { tree } = await readDirTree(root);

    expect(pathsOf(tree)).toEqual(['.gitattributes', '.github/workflows/ci.yml', '.gitignore']);
  });
});

const buildSingle = (entry: TreeEntry): Tree =>
  treeOf({
    [entry.path]: { text: Buffer.from(entry.bytes ?? []).toString('utf8'), exec: entry.exec },
  });
