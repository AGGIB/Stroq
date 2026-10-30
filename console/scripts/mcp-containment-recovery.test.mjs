import test from 'node:test';
import assert from 'node:assert/strict';
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, config, preview, apply, vault } from './mcp-containment-test-helpers.mjs';

async function untilFile(path) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  assert.fail('expected durable fixture intent');
}

test('before-source interruption retains intent without changing the occupied registration', async (t) => {
  const f = await fixture(t, { fault: 'after-intent' }),
    installed = await config(f);
  const p = await preview(f.containment, installed),
    result = await apply(f.containment, p.body);
  assert.equal(result.status, 422);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  const state = await f.containment.state();
  assert.equal(state.body.records[0].phase, 'prepared');
  assert.equal(state.body.records[0].status, 'recovery-required');
  assert.equal(state.body.records[0].slot, 'same');
  assert.equal(
    (await f.containment.preview({ action: 'restore-registration', recordId: p.body.recordId }))
      .status,
    409,
  );
});

test('a backup interruption leaves source intact and exposes incomplete recovery material', async (t) => {
  const f = await fixture(t, { fault: 'after-backup' }),
    installed = await config(f);
  const p = await preview(f.containment, installed);
  assert.equal((await apply(f.containment, p.body)).status, 503);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  await access(join(vault(f, p.body.recordId), 'before.json'));
  const state = await f.containment.state();
  assert.equal(state.body.available, false);
  assert.ok(state.body.gaps.some((gap) => gap.code === 'record-invalid'));
});

test('interrupted restore never overwrites an entry when retried', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  const interrupted = f.service({ fault: 'before-final-manifest' });
  const p = await interrupted.preview({
    action: 'restore-registration',
    recordId: removed.body.recordId,
  });
  assert.equal((await apply(interrupted, p.body)).status, 422);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  const state = await f.containment.state();
  assert.equal(state.body.records[0].phase, 'recovery-required');
  assert.equal(state.body.records[0].slot, 'same');
  assert.equal(
    (
      await f.containment.preview({
        action: 'restore-registration',
        recordId: removed.body.recordId,
      })
    ).status,
    409,
  );
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('timeout terminates the worker before releasing the cross-workspace apply lock', async (t) => {
  const f = await fixture(t, { fault: 'pause-after-intent', timeoutMs: 6000 }),
    installed = await config(f, { agent: 'cursor', scope: 'user' });
  const secondProject = join(f.dir, 'second');
  await mkdir(secondProject, { mode: 0o700 });
  const contender = f.service({ project: secondProject, fault: null, timeoutMs: 750 });
  const a = await preview(f.containment, installed),
    b = await preview(contender, installed);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const applying = apply(f.containment, a.body);
  await untilFile(join(vault(f, a.body.recordId), 'manifest.json'));
  const blocked = await apply(contender, b.body);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'mcp-containment-busy');
  const result = await applying;
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'deadline-exceeded');
  await assert.rejects(access(join(f.userHome, '.stroq', '.mcp-containment.apply.lock')));
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  const state = await f.containment.state();
  assert.equal(state.body.records[0].status, 'recovery-required');
});

test('shutdown terminates a paused writer and preserves recoverable intent', async (t) => {
  const f = await fixture(t, { fault: 'pause-after-intent' }),
    installed = await config(f);
  const p = await preview(f.containment, installed),
    applying = apply(f.containment, p.body);
  await untilFile(join(vault(f, p.body.recordId), 'manifest.json'));
  await f.containment.close();
  assert.equal((await applying).body.error, 'server-stopped');
  await assert.rejects(access(join(f.userHome, '.stroq', '.mcp-containment.apply.lock')));
  assert.deepEqual(await readFile(installed.file), installed.bytes);
  const restarted = f.service({ fault: null });
  assert.equal((await restarted.state()).body.records[0].status, 'recovery-required');
});

test('copied recovery stores, missing payloads and permissive retained files fail safely', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  const otherHome = join(f.dir, 'other-user');
  await mkdir(otherHome, { mode: 0o700 });
  await cp(join(f.userHome, '.stroq'), join(otherHome, '.stroq'), { recursive: true });
  const copied = f.service({ userHome: otherHome });
  const copiedState = await copied.state();
  assert.equal(copiedState.body.available, false);
  assert.ok(copiedState.body.gaps.some((gap) => gap.code === 'record-invalid'));
  const before = join(vault(f, removed.body.recordId), 'before.json');
  await chmod(before, 0o644);
  const permissive = await f.containment.state();
  assert.equal(permissive.body.available, false);
  assert.equal(permissive.body.records[0].payload, 'unverifiable');
  await chmod(before, 0o600);
  await rm(before);
  const missing = await f.containment.state();
  assert.equal(missing.body.available, false);
  assert.equal(missing.body.records[0].payload, 'missing');
});

test('own prototype-shaped registration keys and an empty remaining map preserve exact original bytes', async (t) => {
  const f = await fixture(t),
    installed = await config(f, { name: '__proto__' });
  const p = await preview(f.containment, installed);
  assert.equal(p.status, 200);
  const removed = await apply(f.containment, p.body);
  assert.equal(removed.status, 200);
  const current = JSON.parse(await readFile(installed.file, 'utf8'));
  assert.deepEqual(current.mcpServers, {});
  assert.equal({}.command, undefined);
  const restore = await f.containment.preview({
    action: 'restore-registration',
    recordId: removed.body.recordId,
  });
  assert.equal(restore.status, 200);
  assert.equal((await apply(f.containment, restore.body)).status, 200);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('read-only files and replaced project roots cannot be written under an old preview', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  await chmod(installed.file, 0o400);
  assert.equal((await preview(f.containment, installed)).status, 409);
  await chmod(installed.file, 0o600);
  const p = await preview(f.containment, installed);
  await rename(f.project, f.project + '-previous');
  await mkdir(f.project, { mode: 0o700 });
  await writeFile(installed.file, installed.bytes, { mode: 0o600 });
  assert.equal((await apply(f.containment, p.body)).status, 409);
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('runtime-unavailable state preserves derived recovery history without enabling mutations', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  await apply(f.containment, (await preview(f.containment, installed)).body);
  const unavailable = f.service({
    runtimeDigest: async () => {
      throw new Error('fixture-runtime');
    },
  });
  const state = await unavailable.state();
  assert.equal(state.status, 200);
  assert.equal(state.body.reason, 'runtime-unavailable');
  assert.equal(state.body.records[0].status, 'removed');
  assert.equal(
    (
      await unavailable.preview({
        action: 'restore-registration',
        recordId: state.body.records[0].id,
      })
    ).status,
    503,
  );
});

test('a malformed apply reply terminates the worker before releasing the lock', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const workerPath = join(f.dir, 'fixture-worker.mjs'),
    sentinel = join(f.dir, 'must-not-run-after-reply');
  await copyFile(
    new URL('../.local-engine/mcp-containment-worker.js', import.meta.url),
    workerPath,
  );
  const service = f.service({ workerPath });
  const p = await preview(service, installed);
  assert.equal(p.status, 200);
  await writeFile(
    workerPath,
    `import { parentPort } from 'node:worker_threads'; import { writeFile } from 'node:fs/promises'; parentPort.postMessage({ kind:'result',body:{raw:'fixture-secret-never-return'} }); setTimeout(() => writeFile(${JSON.stringify(sentinel)}, 'bad'), 150);`,
  );
  const result = await apply(service, p.body);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'mcp-containment-unavailable');
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
  await assert.rejects(access(join(f.userHome, '.stroq', '.mcp-containment.apply.lock')));
  await new Promise((done) => setTimeout(done, 300));
  await assert.rejects(access(sentinel));
  assert.deepEqual(await readFile(installed.file), installed.bytes);
});

test('a full or oversized vault cannot become an empty available state', async (t) => {
  const f = await fixture(t),
    installed = await config(f);
  const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
  const original = vault(f, removed.body.recordId),
    manifest = JSON.parse(await readFile(join(original, 'manifest.json'), 'utf8'));
  for (let i = 0; i < 31; i++) {
    const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    const directory = vault(f, id);
    await cp(original, directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, id }));
  }
  const state = await f.containment.state();
  assert.equal(state.status, 200);
  assert.equal(state.body.records.length, 32);
  const another = await config(f, { name: 'another' });
  assert.equal((await preview(f.containment, another)).body.error, 'mcp-containment-full');
  await mkdir(vault(f, '00000000-0000-4000-8000-999999999999'), { mode: 0o700 });
  const excess = await f.containment.state();
  assert.equal(excess.status, 200);
  assert.equal(excess.body.available, false);
  assert.ok(excess.body.gaps.some((gap) => gap.code === 'vault-limit'));
});
