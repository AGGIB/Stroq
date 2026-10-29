import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';

const output = await mkdtemp(join(tmpdir(), 'stroq-task-private-time-build-'));
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
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-task-private-time-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'),
    userHome = join(root, 'user'),
    home = join(userHome, '.stroq');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  await mkdir(join(project, '.vscode'), { mode: 0o700 });
  const target = join(project, '.vscode/tasks.json');
  await writeFile(target, content, { mode: 0o644 });
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
  const plan = await tx.prepareTaskDisable(options, source, {
    recordId: randomUUID(),
    expiresAt: Date.now() + 120000,
  });
  const record = await tx.applyTaskChange(options, plan, { guard: async () => {} });
  assert.equal(record.manifest.phase, 'manual');
  return { options, target, record };
}

for (const contradiction of [
  'source-after-intent',
  'verification-before-intent',
  'verification-after-update',
]) {
  test(`private vault refuses ${contradiction} without changing retained bytes or the source`, async (t) => {
    const f = await fixture(t);
    const manifest = structuredClone(f.record.manifest);
    manifest.source.capturedAt = '2026-01-01T00:00:00.000Z';
    manifest.createdAt = '2026-01-01T00:01:00.000Z';
    manifest.changedAt = '2026-01-01T00:02:00.000Z';
    manifest.verification = {
      status: 'recorded',
      runId: randomUUID(),
      captureSha256: 'd'.repeat(64),
      capturedAt: '2026-01-01T00:01:30.000Z',
      complete: true,
      sourceMatches: true,
    };
    await writeFile(f.record.path, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    assert.equal(
      (await tx.readTaskVault(f.options)).records.length,
      1,
      'Control chronology is accepted',
    );
    if (contradiction === 'source-after-intent')
      manifest.source.capturedAt = '2026-01-01T00:01:01.000Z';
    if (contradiction === 'verification-before-intent')
      manifest.verification.capturedAt = '2026-01-01T00:00:59.000Z';
    if (contradiction === 'verification-after-update')
      manifest.verification.capturedAt = '2026-01-01T00:02:01.000Z';
    const malformed = Buffer.from(`${JSON.stringify(manifest)}\n`);
    await writeFile(f.record.path, malformed, { mode: 0o600 });
    const before = await readFile(f.target);
    await assert.rejects(tx.readTaskVault(f.options), /task-store-unavailable/);
    assert.deepEqual(
      await readFile(f.target),
      before,
      'Passive inspection does not change the task file',
    );
    assert.deepEqual(
      await readFile(f.record.path),
      malformed,
      'Passive inspection does not repair private history',
    );
  });
}
