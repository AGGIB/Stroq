import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  putStore,
  readStoredTree,
  storePath,
  assertWritableTree,
  assertInstallablePlatform,
} from '../../src/install/store.js';
import { treeDigest } from '../../src/install/tree.js';
import { treeOf } from '../helpers/install-tree.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'stroq-store-'));
  roots.push(home);
  const tree = treeOf({
    'SKILL.md': '# demo\n',
    'bin/run': { text: '#!/bin/sh\necho hi\n', exec: true },
  });
  const digest = treeDigest(tree);
  const folder = await putStore(home, tree, digest);
  return { home, tree, digest, folder };
}

describe('confirmed bytes in the content-addressed store', () => {
  it('refuses executable metadata on Windows on every host', () => {
    const executable = treeOf({ 'run.sh': { text: 'echo hi', exec: true } });
    expect(() => assertInstallablePlatform(executable, 'win32')).toThrow(/Windows cannot preserve/);
    expect(() => assertInstallablePlatform(executable, 'linux')).not.toThrow();
    expect(() =>
      assertInstallablePlatform(treeOf({ 'SKILL.md': '# demo' }), 'win32'),
    ).not.toThrow();
  });
  it('keeps exec metadata without executable store files and reuses only a verified store', async () => {
    const f = await setup();
    expect(f.folder).toBe(join(f.home, 'store', `sha256-${f.digest.slice(0, 32)}`));
    const meta = JSON.parse(await readFile(join(f.folder, 'manifest.json'), 'utf8'));
    expect(meta.entries.find((e: { path: string }) => e.path === 'bin/run')).toMatchObject({
      exec: true,
    });
    expect(meta.entries.every((e: object) => !Object.hasOwn(e, 'bytes'))).toBe(true);
    if (process.platform !== 'win32')
      expect((await stat(join(f.folder, 'tree', 'bin/run'))).mode & 0o111).toBe(0);
    expect(treeDigest(await readStoredTree(f.folder, f.digest))).toBe(f.digest);
    expect(await putStore(f.home, f.tree, f.digest)).toBe(f.folder);
  });

  it('refuses changed bytes on both restore and reuse', async () => {
    const f = await setup();
    await writeFile(join(f.folder, 'tree', 'SKILL.md'), 'tampered');
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow();
    await expect(putStore(f.home, f.tree, f.digest)).rejects.toThrow();
  });

  it('refuses an altered manifest even if its directory prefix is right', async () => {
    const f = await setup();
    await writeFile(join(f.folder, 'manifest.json'), '{"entries":[]}');
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow(/manifest/);
    await writeFile(join(f.folder, 'manifest.json'), 'not JSON');
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow(/manifest/);
  });

  it('refuses added files, including those the source reader normally skips', async () => {
    const f = await setup();
    await writeFile(join(f.folder, 'tree', 'extra'), 'outside');
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow(/files changed/);
    await rm(join(f.folder, 'tree', 'extra'));
    await mkdir(join(f.folder, 'tree', 'node_modules'));
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow(/cannot be verified/);
  });

  it('refuses renamed paths and missing stores', async () => {
    const f = await setup();
    await rm(join(f.folder, 'tree', 'SKILL.md'));
    await writeFile(join(f.folder, 'tree', 'renamed.md'), '# demo\n');
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow(/paths changed/);
    await rm(f.folder, { recursive: true });
    await expect(readStoredTree(f.folder, f.digest)).rejects.toThrow(/missing/);
  });

  it('rejects missing buffers, links, wrong digests and unsafe store keys', async () => {
    const tree = treeOf({ link: { symlink: 'elsewhere' } });
    expect(() => assertWritableTree(tree, treeDigest(tree))).toThrow(/links/);
    const plain = treeOf({ 'SKILL.md': '# demo\n' });
    expect(() => assertWritableTree(plain, 'a'.repeat(64))).toThrow(/bytes changed/);
    const metadata = { entries: plain.entries.map(({ bytes: _bytes, ...entry }) => entry) };
    expect(() => assertWritableTree(metadata, treeDigest(plain))).toThrow(/missing bytes/);
    expect(() => storePath('home', '../escape')).toThrow(/digest/);
  });
});
