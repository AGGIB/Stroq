import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRunStore as createStore, MAX_HISTORY_BYTES } from './run-store.mjs';
import { validateRun } from '../.local-engine/control-schema.js';

const id = '00000000-0000-4000-a000-000000000001';
const workspaceId = 'a'.repeat(64);
const createRunStore = (options = {}) => createStore({ workspaceId, ...options });
const startedAt = '2026-10-23T00:00:00.000Z';
const running = { id, kind: 'doctor', status: 'running', startedAt };
const failed = { ...running, status: 'failed', finishedAt: startedAt, error: 'engine-failed' };
const envelope = (runs) => JSON.stringify({ schema: 'stroq-runs/2', workspaceId, runs });
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-run-store-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  return {
    root,
    home,
    directory: join(home, 'console'),
    file: join(home, 'console', `runs-${workspaceId}.json`),
  };
}
async function seed(files, text, mode = 0o600) {
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  await writeFile(files.file, text, { mode });
}

test('missing store creates no directories until a run is accepted; writes are private, bounded and survive reload', async (t) => {
  const files = await fixture(t);
  const store = await createRunStore({ home: files.home });
  assert.deepEqual(store.state(), { status: 'ready' });
  assert.deepEqual(store.runs, []);
  await assert.rejects(lstat(files.home), { code: 'ENOENT' });
  assert.equal(await store.write([running]), true);
  assert.equal((await lstat(files.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(files.file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(files.file, 'utf8')), JSON.parse(envelope([running])));
  const restored = await createRunStore({ home: files.home });
  assert.deepEqual(restored.runs, [running]);
  assert.equal(await restored.write([failed]), true);
  assert.deepEqual((await createRunStore({ home: files.home })).runs, [failed]);
  assert.ok(validateRun(failed));
});

test('disabled storage is explicit and does not interfere with in-memory actions', async () => {
  const store = await createRunStore();
  assert.deepEqual(store.state(), { status: 'disabled' });
  assert.equal(await store.write([failed]), false);
});

test('explicit admission can prepare private parents without rewriting or creating retained history', async (t) => {
  const files = await fixture(t);
  const store = await createRunStore({ home: files.home });
  assert.equal(typeof store.prepare, 'function');
  assert.equal(await store.prepare(), true);
  assert.equal((await lstat(files.directory)).mode & 0o777, 0o700);
  await assert.rejects(lstat(files.file), { code: 'ENOENT' });
  assert.equal(await store.write([running]), true);
  const bytes = await readFile(files.file, 'utf8');
  assert.equal(await store.prepare(), true);
  assert.equal(await readFile(files.file, 'utf8'), bytes);
  await writeFile(files.file, '{broken');
  const refused = await createRunStore({ home: files.home });
  assert.equal(await refused.prepare(), false);
  assert.equal(await readFile(files.file, 'utf8'), '{broken');
});

test('fixed hook-check history namespace is isolated from diagnostic history', async (t) => {
  const files = await fixture(t);
  const diagnostics = await createRunStore({ home: files.home });
  assert.equal(await diagnostics.write([failed]), true);
  const hookChecks = await createRunStore({ home: files.home, namespace: 'hook-checks' });
  assert.deepEqual(hookChecks.runs, []);
  assert.equal(await hookChecks.write([running]), true);
  assert.deepEqual((await createRunStore({ home: files.home })).runs, [failed]);
  assert.deepEqual((await createRunStore({ home: files.home, namespace: 'hook-checks' })).runs, [
    running,
  ]);
  assert.equal(
    (await lstat(join(files.directory, `hook-checks-${workspaceId}.json`))).mode & 0o777,
    0o600,
  );
});

test('arbitrary history namespaces cannot choose a filesystem path', async (t) => {
  const files = await fixture(t);
  for (const namespace of ['../outside', '', 'other']) {
    const store = await createRunStore({ home: files.home, namespace });
    assert.deepEqual(store.state(), { status: 'error', error: 'unavailable' });
    assert.equal(await store.write([failed]), false);
  }
  await assert.rejects(lstat(files.home), { code: 'ENOENT' });
});

test('fixed network-check namespace has independent bounded private history', async (t) => {
  const files = await fixture(t);
  const options = { home: files.home, namespace: 'codex-network-checks' };
  const store = await createRunStore(options);
  assert.deepEqual(store.state(), { status: 'ready' });
  await assert.rejects(lstat(files.home), { code: 'ENOENT' });
  assert.equal(await store.write([failed]), true);
  assert.deepEqual((await createRunStore(options)).runs, [failed]);
  assert.deepEqual((await createRunStore({ home: files.home })).runs, []);
  assert.equal(
    (await lstat(join(files.directory, `codex-network-checks-${workspaceId}.json`))).mode & 0o777,
    0o600,
  );
});

test('passive refresh observes another writer without creating, repairing or changing history', async (t) => {
  const files = await fixture(t),
    a = await createRunStore({ home: files.home }),
    b = await createRunStore({ home: files.home });
  assert.deepEqual(await b.refresh(), []);
  await assert.rejects(lstat(files.home), { code: 'ENOENT' });
  assert.equal(await a.write([running]), true);
  const before = await readFile(files.file);
  assert.deepEqual(await b.refresh(), [running]);
  assert.deepEqual(await readFile(files.file), before);
  assert.equal(await a.write([failed]), true);
  assert.deepEqual(await b.refresh(), [failed]);
  await writeFile(files.file, '{invalid');
  assert.equal(await b.refresh(), null);
  assert.deepEqual(b.state(), { status: 'error', error: 'invalid-history' });
  assert.equal(await readFile(files.file, 'utf8'), '{invalid');
});

test('refresh retains the original physical parent binding after observing storage', async (t) => {
  const files = await fixture(t),
    store = await createRunStore({ home: files.home });
  await store.write([running]);
  await store.refresh();
  await import('node:fs/promises').then((fs) => fs.rename(files.home, files.home + '.saved'));
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  await writeFile(files.file, envelope([failed]), { mode: 0o600 });
  assert.equal(await store.refresh(), null);
  assert.deepEqual(store.state(), { status: 'error', error: 'unsafe-path' });
  assert.equal(await readFile(files.file, 'utf8'), envelope([failed]));
});

test('workspace review history has its own fixed private namespace and injected validator', async (t) => {
  const files = await fixture(t);
  const diagnostics = await createRunStore({ home: files.home });
  assert.equal(await diagnostics.write([failed]), true);
  const reviewed = { ...running, kind: 'workspace-review-fixture' };
  const loadValidator = async () => ({
    validateRun: (value) => JSON.stringify(value) === JSON.stringify(reviewed),
  });
  const options = { home: files.home, namespace: 'workspace-review', loadValidator };
  const workspace = await createRunStore(options);
  assert.deepEqual(workspace.state(), { status: 'ready' });
  assert.deepEqual(workspace.runs, []);
  assert.equal(await workspace.write([reviewed]), true);
  assert.deepEqual((await createRunStore(options)).runs, [reviewed]);
  assert.deepEqual((await createRunStore({ home: files.home })).runs, [failed]);
  assert.equal(
    (await lstat(join(files.directory, `workspace-review-${workspaceId}.json`))).mode & 0o777,
    0o600,
  );
  assert.equal(await workspace.write([failed]), false, 'the supplied report validator is enforced');
});

test('an injected strict history parser can refuse ambiguous JSON without overwriting it', async (t) => {
  const files = await fixture(t);
  const bytes = envelope([failed]);
  await seed(files, bytes);
  let called = 0;
  const store = await createRunStore({
    home: files.home,
    loadValidator: async () => ({
      validateRun,
      parseHistory: (text) => {
        assert.equal(text, bytes);
        called++;
        throw new Error('invalid-history');
      },
    }),
  });
  assert.equal(called, 1);
  assert.deepEqual(store.state(), { status: 'error', error: 'invalid-history' });
  assert.deepEqual(store.runs, []);
  assert.equal(await store.write([failed]), false);
  assert.equal(await readFile(files.file, 'utf8'), bytes);
});

test('malformed, contradictory and secret-bearing history is refused and never overwritten', async (t) => {
  const invalid = [
    '{broken',
    envelope([{ ...failed, content: 'secret-value' }]),
    envelope([{ ...failed, result: { raw: 'secret-value' } }]),
    envelope([failed, failed]),
    envelope(Array(33).fill(failed)),
    envelope([{ ...running, kind: 'exec' }]),
    JSON.stringify({ schema: 'stroq-runs/2', workspaceId, runs: [failed], raw: 'secret-value' }),
    JSON.stringify({ schema: 'stroq-runs/1', runs: [failed] }),
    JSON.stringify({ schema: 'stroq-runs/2', workspaceId: 'b'.repeat(64), runs: [failed] }),
  ];
  for (const text of invalid) {
    const files = await fixture(t);
    await seed(files, text);
    const store = await createRunStore({ home: files.home });
    assert.deepEqual(store.state(), { status: 'error', error: 'invalid-history' });
    assert.deepEqual(store.runs, []);
    assert.equal(await store.write([failed]), false);
    assert.equal(await readFile(files.file, 'utf8'), text);
  }
});

test('oversized and invalid UTF-8 histories are rejected before they reach the UI', async (t) => {
  for (const text of [Buffer.alloc(MAX_HISTORY_BYTES + 1, 32), Buffer.from([0xff, 0xfe])]) {
    const files = await fixture(t);
    await seed(files, text);
    const store = await createRunStore({ home: files.home });
    assert.equal(store.state().status, 'error');
    assert.deepEqual(store.runs, []);
  }
});

test('store rejects symlinked home, console, history and hardlinked history without writing targets', async (t) => {
  for (const target of ['home', 'directory', 'file', 'hardlink']) {
    const files = await fixture(t);
    const outside = join(files.root, 'outside');
    await mkdir(outside, { mode: 0o700 });
    const secret = join(outside, 'secret');
    await writeFile(secret, 'secret-value', { mode: 0o600 });
    if (target === 'home') await symlink(outside, files.home);
    if (target === 'directory') {
      await mkdir(files.home, { mode: 0o700 });
      await symlink(outside, files.directory);
    }
    if (['file', 'hardlink'].includes(target)) {
      await mkdir(files.directory, { recursive: true, mode: 0o700 });
      if (target === 'file') await symlink(secret, files.file);
      else await link(secret, files.file);
    }
    const store = await createRunStore({ home: files.home });
    assert.deepEqual(store.state(), { status: 'error', error: 'unsafe-path' }, target);
    assert.equal(await store.write([failed]), false);
    assert.equal(await readFile(secret, 'utf8'), 'secret-value');
  }
});

test('broad file and console permissions are refused rather than silently tightened', async (t) => {
  for (const target of ['directory', 'file']) {
    const files = await fixture(t);
    await seed(files, envelope([failed]));
    await chmod(files[target], 0o755);
    const store = await createRunStore({ home: files.home });
    assert.deepEqual(store.state(), { status: 'error', error: 'unsafe-path' });
    assert.equal(await store.write([running]), false);
    assert.equal((await lstat(files[target])).mode & 0o777, 0o755);
  }
});

test('concurrent replacement and path substitutions stop persistence without overwriting the new file', async (t) => {
  const files = await fixture(t);
  await seed(files, envelope([failed]));
  const store = await createRunStore({ home: files.home });
  const concurrent = envelope([{ ...failed, error: 'server-stopped' }]);
  await writeFile(files.file, concurrent);
  assert.equal(await store.write([running]), false);
  assert.deepEqual(store.state(), { status: 'error', error: 'write-failed' });
  assert.equal(await readFile(files.file, 'utf8'), concurrent);
});

test('unavailable schema validation reports a bounded error without exposing module paths', async (t) => {
  const files = await fixture(t);
  const store = await createRunStore({
    home: files.home,
    loadValidator: async () => {
      throw new Error('/private/secret-value');
    },
  });
  assert.deepEqual(store.state(), { status: 'error', error: 'unavailable' });
  assert.ok(!JSON.stringify(store.state()).includes('secret-value'));
});

test('unknown fields in new runs cannot be written to disk', async (t) => {
  const files = await fixture(t);
  const store = await createRunStore({ home: files.home });
  assert.equal(await store.write([{ ...failed, content: 'secret-value' }]), false);
  assert.deepEqual(store.state(), { status: 'error', error: 'write-failed' });
  await assert.rejects(lstat(files.file), { code: 'ENOENT' });
});

test('private directories created by another platform action can be adopted before the first run', async (t) => {
  for (const homeExists of [true, false]) {
    const files = await fixture(t);
    if (homeExists) await mkdir(files.home, { mode: 0o700 });
    const store = await createRunStore({ home: files.home });
    await mkdir(files.directory, { recursive: true, mode: 0o700 });
    assert.equal(await store.write([failed]), true);
    assert.deepEqual(store.state(), { status: 'ready' });
    assert.deepEqual((await createRunStore({ home: files.home })).runs, [failed]);
  }
});

test('workspaces sharing a user profile cannot import each other or unscoped legacy history', async (t) => {
  const files = await fixture(t);
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  const legacy = join(files.directory, 'runs.json');
  const original = JSON.stringify({ schema: 'stroq-runs/1', runs: [failed] });
  await writeFile(legacy, original, { mode: 0o600 });
  const first = await createRunStore({ home: files.home });
  assert.deepEqual(first.runs, []);
  assert.equal(await first.write([failed]), true);
  const other = await createRunStore({ home: files.home, workspaceId: 'b'.repeat(64) });
  assert.deepEqual(other.runs, []);
  assert.equal(await other.write([]), true);
  assert.deepEqual((await createRunStore({ home: files.home })).runs, [failed]);
  assert.equal(await readFile(legacy, 'utf8'), original);
});

test('the namespace identifier cannot be a browser path or escape the private store', async (t) => {
  const files = await fixture(t);
  for (const invalid of ['../outside', '', null, 'b'.repeat(63), 'B'.repeat(64)]) {
    const store = await createRunStore({ home: files.home, workspaceId: invalid });
    assert.deepEqual(store.state(), { status: 'error', error: 'unavailable' });
    assert.equal(await store.write([failed]), false);
  }
  await assert.rejects(lstat(files.home), { code: 'ENOENT' });
});
