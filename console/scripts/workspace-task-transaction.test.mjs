import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';

let directory, tx;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const content = Buffer.from(
  '\ufeff{\r\n// keep comment exactly\r\n"version":"2.0.0","tasks":[{"label":"on open","command":"DO_NOT_EXECUTE_SENTINEL","runOptions":{"runOn":"folderOpen", "instanceLimit":1}},{"label":"on worktree","command":"KEEP_MANUAL_COMMAND","runOptions":{"runOn":"worktreeCreated"}},{"label":"manual","command":"KEEP_MANUAL_COMMAND"}],\r\n}\r\n',
);
before(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-workspace-task-build-')));
  await build({
    entry: { transaction: join(import.meta.dirname, 'workspace-task-transaction.ts') },
    outDir: directory,
    outExtension: () => ({ js: '.mjs' }),
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    splitting: false,
    config: false,
    dts: false,
    silent: true,
  });
  tx = await import(pathToFileURL(join(directory, 'transaction.mjs')).href);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'stroq-workspace-task-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project'),
    userHome = join(base, 'user');
  await mkdir(project, { mode: 0o700 });
  await mkdir(userHome, { mode: 0o700 });
  await mkdir(join(project, '.vscode'), { mode: 0o700 });
  const path = join(project, '.vscode', 'tasks.json');
  await writeFile(path, content, { mode: 0o644 });
  const options = {
    project,
    userHome,
    home: join(userHome, '.stroq'),
    roots: { project: await rootIdentity(project), user: await rootIdentity(userHome) },
    workspaceId: `workspace-${hash(project).slice(0, 24)}`,
    storeId: hash(project),
    engineVersion: '0.28.0',
    runtimeSha256: 'a'.repeat(64),
    deadline: Date.now() + 25000,
  };
  const source = {
    runId: randomUUID(),
    captureSha256: 'b'.repeat(64),
    sourceId: `source-${hash('workspace\0.vscode/tasks.json')}`,
    sourceSha256: hash(content),
    sourceMode: 0o644,
    capturedAt: new Date().toISOString(),
    captureComplete: true,
    scopeSha256: 'c'.repeat(64),
    engineVersion: options.engineVersion,
    runtimeSha256: options.runtimeSha256,
  };
  const meta = { recordId: randomUUID(), expiresAt: Date.now() + 120000 };
  return {
    base,
    path,
    options,
    source,
    meta,
    plan: () => tx.prepareTaskDisable(options, source, meta),
    guard: async () => {
      if (Date.now() >= meta.expiresAt) throw new Error('task-preview-expired');
    },
  };
}
const hooks = (f, fault) => ({ guard: f.guard, fault });
test('a source-bound preview is read-only and preserves every unrelated JSONC byte', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  assert.deepEqual(await readFile(f.path), content);
  await assert.rejects(lstat(f.options.home), { code: 'ENOENT' });
  assert.deepEqual(plan.changes, { folderOpen: 1, worktreeCreated: 1 });
  assert.deepEqual(
    plan.candidate,
    Buffer.from(
      content
        .toString()
        .replace('"folderOpen"', '"default"')
        .replace('"worktreeCreated"', '"default"'),
    ),
  );
  assert.equal(plan.before.sha256, f.source.sourceSha256);
  await assert.rejects(lstat(join(f.base, 'DO_NOT_EXECUTE_SENTINEL')), { code: 'ENOENT' });
});
test('apply and guarded restore retain exact bytes, mode and privately bound recovery evidence', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  const applied = await tx.applyTaskChange(f.options, plan, hooks(f));
  assert.equal(applied.manifest.phase, 'manual');
  assert.deepEqual(await readFile(f.path), plan.candidate);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o644);
  const state = await tx.readTaskVault(f.options);
  assert.equal(state.records.length, 1);
  const stored = state.records[0];
  assert.equal((await lstat(stored.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(stored.directory, 'before.jsonc'))).mode & 0o777, 0o600);
  const restore = await tx.prepareTaskRestore(
    f.options,
    { recordId: stored.manifest.id, expectedRevision: stored.revision },
    f.meta.expiresAt,
  );
  const restored = await tx.applyTaskChange(f.options, restore, hooks(f));
  assert.equal(restored.manifest.phase, 'restored');
  assert.deepEqual(await readFile(f.path), content);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o644);
});
test('source SHA, mode and fresh physical pins refuse drift including same-byte replacement', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    tx.prepareTaskDisable(f.options, { ...f.source, sourceSha256: 'c'.repeat(64) }, f.meta),
    /stale-task-source/,
  );
  const plan = await f.plan();
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, content, { mode: 0o644 });
  await assert.rejects(tx.applyTaskChange(f.options, plan, hooks(f)), /stale-task-source/);
  await assert.rejects(lstat(f.options.home), { code: 'ENOENT' });
});
test('a prepared owned publication is resolved only by an explicit guarded recheck', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  await assert.rejects(
    tx.applyTaskChange(
      f.options,
      plan,
      hooks(f, (stage) => {
        if (stage === 'after-target-rename') throw new Error('fixture-crash');
      }),
    ),
    /task-write-unconfirmed/,
  );
  const before = await tx.readTaskVault(f.options),
    record = before.records[0];
  assert.equal(record.manifest.phase, 'prepared');
  assert.deepEqual(await readFile(f.path), plan.candidate);
  const manifestBytes = await readFile(record.path);
  assert.equal((await tx.readTaskVault(f.options)).records[0].manifest.phase, 'prepared');
  assert.deepEqual(await readFile(record.path), manifestBytes);
  const checked = await tx.recheckTaskChange(
    f.options,
    record.manifest.id,
    record.revision,
    hooks(f),
  );
  assert.equal(checked.manifest.phase, 'manual');
});
test('identical foreign bytes are not proof of our staged publication after an interrupted write', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  await assert.rejects(
    tx.applyTaskChange(
      f.options,
      plan,
      hooks(f, (stage) => {
        if (stage === 'after-target-rename') throw new Error('fixture-crash');
      }),
    ),
    /task-write-unconfirmed/,
  );
  const record = (await tx.readTaskVault(f.options)).records[0];
  await rename(f.path, `${f.path}.old`);
  await writeFile(f.path, plan.candidate, { mode: 0o644 });
  await assert.rejects(
    tx.recheckTaskChange(f.options, record.manifest.id, record.revision, hooks(f)),
    /task-recovery-required/,
  );
  assert.equal((await tx.readTaskVault(f.options)).records[0].manifest.phase, 'prepared');
});
test('restore refuses changed, same-byte replaced or permission-changed manual versions', async (t) => {
  for (const drift of ['bytes', 'inode', 'mode']) {
    const f = await fixture(t),
      plan = await f.plan();
    const record = await tx.applyTaskChange(f.options, plan, hooks(f));
    if (drift === 'bytes') await writeFile(f.path, Buffer.from('{}'));
    if (drift === 'inode') {
      await rename(f.path, `${f.path}.old`);
      await writeFile(f.path, plan.candidate, { mode: 0o644 });
    }
    if (drift === 'mode') await chmod(f.path, 0o600);
    await assert.rejects(
      tx.prepareTaskRestore(
        f.options,
        { recordId: record.manifest.id, expectedRevision: record.revision },
        f.meta.expiresAt,
      ),
      /stale-task-source|task-recovery-required/,
    );
  }
});
test('expired or missing commit authority and changed recovery bytes cannot write the target', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  await assert.rejects(
    tx.applyTaskChange(f.options, plan, {
      guard: async () => {
        throw new Error('task-preview-expired');
      },
    }),
    /task-preview-expired/,
  );
  assert.deepEqual(await readFile(f.path), content);
  const record = await tx.applyTaskChange(f.options, plan, hooks(f));
  await writeFile(join(record.directory, 'before.jsonc'), Buffer.from('{}'));
  await assert.rejects(tx.readTaskVault(f.options), /task-store-unavailable/);
  await assert.rejects(
    tx.prepareTaskRestore(
      f.options,
      { recordId: record.manifest.id, expectedRevision: record.revision },
      f.meta.expiresAt,
    ),
    /task-store-unavailable/,
  );
});
test('an interrupted staged change before target rename rechecks as unchanged without another target write', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  await assert.rejects(
    tx.applyTaskChange(
      f.options,
      plan,
      hooks(f, (stage) => {
        if (stage === 'before-target-rename') throw new Error('fixture-crash');
      }),
    ),
    /task-write-unconfirmed/,
  );
  const record = (await tx.readTaskVault(f.options)).records[0];
  assert(record.manifest.staged);
  assert.deepEqual(await readFile(f.path), content);
  const stat = await lstat(f.path);
  const checked = await tx.recheckTaskChange(
    f.options,
    record.manifest.id,
    record.revision,
    hooks(f),
  );
  assert.equal(checked.manifest.phase, 'not-applied');
  assert.equal((await lstat(f.path)).ino, stat.ino);
});
test('an interrupted restore before target rename rechecks the exact owned manual version', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  const manual = await tx.applyTaskChange(f.options, plan, hooks(f));
  const restore = await tx.prepareTaskRestore(
    f.options,
    { recordId: manual.manifest.id, expectedRevision: manual.revision },
    f.meta.expiresAt,
  );
  await assert.rejects(
    tx.applyTaskChange(
      f.options,
      restore,
      hooks(f, (stage) => {
        if (stage === 'before-target-rename') throw new Error('fixture-crash');
      }),
    ),
    /task-write-unconfirmed/,
  );
  const record = (await tx.readTaskVault(f.options)).records[0];
  assert.equal(record.manifest.phase, 'restoring');
  const checked = await tx.recheckTaskChange(
    f.options,
    record.manifest.id,
    record.revision,
    hooks(f),
  );
  assert.equal(checked.manifest.phase, 'manual');
  assert.deepEqual(await readFile(f.path), plan.candidate);
});
test('unknown recovery payloads fail closed without target writes', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  const record = await tx.applyTaskChange(f.options, plan, hooks(f));
  await writeFile(join(record.directory, 'extra-private-payload'), 'unexpected', { mode: 0o600 });
  await assert.rejects(tx.readTaskVault(f.options), /task-store-unavailable/);
  assert.deepEqual(await readFile(f.path), plan.candidate);
});
test('expiry at final metadata rename preserves a prepared exact publication for explicit recheck', async (t) => {
  const f = await fixture(t),
    plan = await f.plan();
  let expired = false;
  await assert.rejects(
    tx.applyTaskChange(f.options, plan, {
      guard: async () => {
        if (expired) throw new Error('task-preview-expired');
      },
      fault: (stage) => {
        if (stage === 'before-final-metadata') expired = true;
      },
    }),
    /task-write-unconfirmed/,
  );
  assert.deepEqual(await readFile(f.path), plan.candidate);
  const record = (await tx.readTaskVault(f.options)).records[0];
  assert.equal(record.manifest.phase, 'prepared');
  assert(record.manifest.staged);
  const checked = await tx.recheckTaskChange(
    f.options,
    record.manifest.id,
    record.revision,
    hooks(f),
  );
  assert.equal(checked.manifest.phase, 'manual');
});
test('bounded unpublished staging consumes global capacity before any new recovery or target writes', async (t) => {
  const f = await fixture(t),
    vault = join(f.options.home, 'console', 'workspace-task-controls');
  await mkdir(vault, { recursive: true, mode: 0o700 });
  await writeFile(join(vault, '.gitignore'), '*\n', { mode: 0o600 });
  for (let i = 0; i < 28; i++)
    await mkdir(join(vault, `.prepared-${randomUUID()}`), { mode: 0o700 });
  const retained = await tx.readTaskVault(f.options);
  assert.equal(retained.count, 28);
  assert(retained.bytes <= 8 * 1024 * 1024);
  const plan = await f.plan();
  // A twenty-ninth reserved stage cannot fit in the unchanged eight-MiB bound.
  await assert.rejects(tx.applyTaskChange(f.options, plan, hooks(f)), /task-store-full/);
  assert.equal((await tx.readTaskVault(f.options)).count, 28);
  assert.deepEqual(await readFile(f.path), content);
});
test('an interrupted first marker publication remains bounded and read-only, never recovery authority', async (t) => {
  const f = await fixture(t),
    vault = join(f.options.home, 'console', 'workspace-task-controls');
  await mkdir(vault, { recursive: true, mode: 0o700 });
  const marker = join(vault, `.stroq-${randomUUID()}.tmp`);
  await writeFile(marker, '*', { mode: 0o600 });
  const before = await readFile(marker),
    state = await tx.readTaskVault(f.options);
  assert.equal(state.records.length, 0);
  assert.equal(state.count, 1);
  assert.deepEqual(await readFile(marker), before);
  const plan = await f.plan(),
    record = await tx.applyTaskChange(f.options, plan, hooks(f));
  assert.equal(record.manifest.phase, 'manual');
  assert.deepEqual(await readFile(marker), before);
});
test('recovery metadata reserves enough space for both old and staged CAS versions', async (t) => {
  const f = await fixture(t),
    plan = await f.plan(),
    record = await tx.applyTaskChange(f.options, plan, hooks(f));
  const valid = await readFile(record.path);
  await writeFile(record.path, Buffer.concat([valid, Buffer.alloc(18000 - valid.length, 0x20)]));
  await assert.rejects(tx.readTaskVault(f.options), /task-store-unavailable/);
  assert.deepEqual(await readFile(f.path), plan.candidate);
});
