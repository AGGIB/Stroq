import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';

const output = await mkdtemp(join(tmpdir(), 'stroq-task-orphan-build-'));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { transaction: join(import.meta.dirname, 'workspace-task-transaction.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  splitting: false,
  config: false,
  dts: false,
  silent: true,
});
const tx = await import(pathToFileURL(join(output, 'transaction.mjs')).href);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const content = Buffer.from(
  '{"version":"2.0.0","tasks":[{"label":"inert","command":"DO_NOT_EXECUTE","runOptions":{"runOn":"folderOpen"}}]}\n',
);
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function tree(root, at = root, out = []) {
  for (const name of (await readdir(at)).sort()) {
    const path = join(at, name),
      stat = await lstat(path);
    assert(!stat.isSymbolicLink());
    out.push([
      relative(root, path),
      stat.isDirectory() ? 'directory' : 'file',
      stat.mode & 0o777,
      stat.ino,
      stat.isFile() ? hash(await readFile(path)) : null,
    ]);
    if (stat.isDirectory()) await tree(root, path, out);
  }
  return out;
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-orphan-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  await mkdir(join(project, '.vscode'), { mode: 0o700 });
  const path = join(project, '.vscode/tasks.json');
  await writeFile(path, content, { mode: 0o644 });
  const options = {
    project,
    userHome,
    home,
    roots: { project: await rootIdentity(project), user: await rootIdentity(userHome) },
    workspaceId: 'workspace-' + hash(project).slice(0, 24),
    storeId: hash(project),
    engineVersion: '0.28.0',
    runtimeSha256: 'a'.repeat(64),
    deadline: Date.now() + 120000,
  };
  const source = {
    runId: randomUUID(),
    captureSha256: 'b'.repeat(64),
    sourceId: 'source-' + hash('workspace\0.vscode/tasks.json'),
    sourceSha256: hash(content),
    sourceMode: 0o644,
    capturedAt: new Date().toISOString(),
    captureComplete: true,
    scopeSha256: 'c'.repeat(64),
    engineVersion: options.engineVersion,
    runtimeSha256: options.runtimeSha256,
  };
  return { root, project, userHome, home, path, options, source };
}

for (const boundary of ['before-backup', 'after-backup']) {
  test(`interruption ${boundary} retains a bounded passive stage without globally disabling recovery`, async (t) => {
    const f = await fixture(t),
      recordId = randomUUID();
    const plan = await tx.prepareTaskDisable(f.options, f.source, {
      recordId,
      expiresAt: Date.now() + 120000,
    });
    let fired = false;
    const guard = async () => {
      const vault = join(f.home, 'console/workspace-task-controls');
      for (const name of [recordId, '.prepared-' + recordId]) {
        const directory = join(vault, name);
        if (!(await exists(directory))) continue;
        const backup = await exists(join(directory, 'before.jsonc')),
          manifest = await exists(join(directory, 'record.json'));
        if (!manifest && (boundary === 'before-backup' ? !backup : backup)) {
          fired = true;
          throw new Error('task-preview-expired');
        }
      }
    };
    await assert.rejects(
      tx.applyTaskChange(f.options, plan, { guard }),
      /task-preview-expired|task-write-unconfirmed/,
    );
    assert(fired, 'The intended pre-publication fault must actually be reached');
    assert.deepEqual(
      await readFile(f.path),
      content,
      'No source write before a complete durable intent',
    );
    const retained = await tree(f.home);
    const vault = await tx.readTaskVault(f.options);
    assert.equal(
      vault.records.length,
      0,
      'An incomplete stage has no recovery or restoration authority',
    );
    assert(vault.count >= 1 && vault.count <= 32);
    assert(vault.bytes <= 8 * 1024 * 1024);
    assert.deepEqual(
      await tree(f.home),
      retained,
      'GET-style inspection must not clean up or adopt staging bytes',
    );
    const foreignProject = join(f.root, 'foreign');
    await mkdir(foreignProject, { mode: 0o700 });
    const foreign = {
      ...f.options,
      project: foreignProject,
      workspaceId: 'workspace-' + hash(foreignProject).slice(0, 24),
      storeId: hash(foreignProject),
      roots: { ...f.options.roots, project: await rootIdentity(foreignProject) },
    };
    const foreignVault = await tx.readTaskVault(foreign);
    assert.equal(
      foreignVault.records.length,
      0,
      'Unpublished or foreign payloads never become selected-workspace records',
    );
    assert.equal(foreignVault.count, vault.count);
    assert.equal(foreignVault.bytes, vault.bytes);
    assert.deepEqual(await tree(f.home), retained);
    const fresh = await tx.prepareTaskDisable(
      f.options,
      { ...f.source, runId: randomUUID() },
      { recordId: randomUUID(), expiresAt: Date.now() + 120000 },
    );
    const applied = await tx.applyTaskChange(f.options, fresh, { guard: async () => {} });
    assert.equal(applied.manifest.phase, 'manual');
    assert.deepEqual(await readFile(f.path), fresh.candidate);
    const after = await tx.readTaskVault(f.options);
    assert.equal(after.records.length, 1);
    assert.notEqual(after.records[0].manifest.id, recordId);
    assert(after.count >= 2 && after.count <= 32);
    assert(after.bytes <= 8 * 1024 * 1024);
  });
}
