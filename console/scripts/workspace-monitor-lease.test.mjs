import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { rootIdentity } from './agent-setup-files.mjs';
import { createWorkspaceMonitorStore } from './workspace-monitor-store.mjs';

const hash = (v) => createHash('sha256').update(v).digest('hex');
async function fixture(t, fault = async () => {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'stroq-monitor-lease-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = join(temp, 'project'),
    user = join(temp, 'user');
  await mkdir(project, { mode: 0o700 });
  await mkdir(user, { mode: 0o700 });
  const roots = { project: await rootIdentity(project), user: await rootIdentity(user) };
  const home = join(user, '.stroq'),
    storeId = hash(`stroq-workspace/1\0${project}\0${roots.project.dev}\0${roots.project.ino}`);
  const config = {
    home,
    roots,
    storeId,
    workspaceId: `workspace-${hash(project).slice(0, 24)}`,
    fault,
  };
  const store = createWorkspaceMonitorStore(config);
  await store.update(
    { engineVersion: '0.28.0', runtimeSha256: 'a'.repeat(64) },
    { enabled: true, expectedRevision: null, configuredAt: '2026-10-24T10:00:00.000Z' },
  );
  const directory = join(home, 'console', 'workspace-monitor-leases'),
    lock = join(directory, `${storeId}.lock`);
  return { temp, home, config, store, directory, lock, owner: join(lock, 'owner.json') };
}
const age = async (path) => {
  const old = new Date(Date.now() - 70000);
  await utimes(path, old, old);
};

test('one enabled workspace has one lease, live owner is never reaped, release is idempotent', async (t) => {
  const f = await fixture(t),
    before = await f.store.read();
  const first = await f.store.acquireLease();
  assert.ok(first);
  assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.lock)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.owner)).mode & 0o777, 0o600);
  await first.assertCurrent();
  await age(f.lock);
  assert.equal(await createWorkspaceMonitorStore(f.config).acquireLease(), null);
  await first.assertCurrent();
  assert.deepEqual(await f.store.read(), before);
  await first.release();
  await first.release();
  await assert.rejects(lstat(f.lock), { code: 'ENOENT' });
  const next = await f.store.acquireLease();
  assert.ok(next);
  await next.release();
});

test('a crashed real child owner can be reclaimed after bounded stale grace', async (t) => {
  const f = await fixture(t);
  const source = `import {createWorkspaceMonitorStore} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'workspace-monitor-store.mjs')).href)};
    const lease = await createWorkspaceMonitorStore(${JSON.stringify(f.config)}).acquireLease();
    if (!lease) process.exit(2); process.stdout.write('owned'); process.exit(0);`;
  // fault is an internal function and is not serialized into the child configuration.
  const code = source.replace(/,"fault":\{\}/, '');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    errors = '';
  child.stdout.on('data', (v) => (output += v));
  child.stderr.on('data', (v) => (errors += v));
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exit, 0, errors);
  assert.equal(output, 'owned');
  await age(f.lock);
  const lease = await f.store.acquireLease();
  assert.ok(lease);
  await lease.assertCurrent();
  await lease.release();
});

for (const kind of [
  'owner-symlink',
  'owner-hardlink',
  'owner-mode',
  'directory-mode',
  'parent-symlink',
  'owner-duplicate',
  'owner-oversize',
  'unknown-child',
])
  test(`unsafe ${kind} cannot be reclaimed or removed`, async (t) => {
    const f = await fixture(t),
      lease = await f.store.acquireLease();
    assert.ok(lease);
    if (kind === 'owner-symlink') {
      await rename(f.owner, `${f.owner}.old`);
      await symlink(`${f.owner}.old`, f.owner);
    }
    if (kind === 'owner-hardlink') await link(f.owner, join(f.temp, 'owner-link'));
    if (kind === 'owner-mode') await chmod(f.owner, 0o644);
    if (kind === 'directory-mode') await chmod(f.lock, 0o755);
    if (kind === 'parent-symlink') {
      await rename(f.directory, `${f.directory}-old`);
      await symlink(`${f.directory}-old`, f.directory);
    }
    if (kind === 'owner-duplicate')
      await writeFile(f.owner, '{"pid":1,"pid":2,"host":"x","token":"x"}', { mode: 0o600 });
    if (kind === 'owner-oversize') await writeFile(f.owner, ' '.repeat(1025), { mode: 0o600 });
    if (kind === 'unknown-child') await writeFile(join(f.lock, 'foreign'), 'keep', { mode: 0o600 });
    await age(f.lock);
    await assert.rejects(lease.assertCurrent(), /monitor-store-unavailable/);
    await assert.rejects(
      createWorkspaceMonitorStore(f.config).acquireLease(),
      /monitor-store-unavailable/,
    );
    await assert.rejects(lease.release(), /monitor-store-unavailable/);
    assert.ok((await lstat(f.lock)).isDirectory());
  });

test('release never removes a substituted lock with identical owner bytes', async (t) => {
  const f = await fixture(t),
    lease = await f.store.acquireLease();
  assert.ok(lease);
  const original = await readFile(f.owner);
  await rename(f.lock, `${f.lock}-old`);
  await mkdir(f.lock, { mode: 0o700 });
  await writeFile(f.owner, original, { mode: 0o600 });
  await assert.rejects(lease.assertCurrent(), /monitor-store-unavailable/);
  await assert.rejects(lease.release(), /monitor-store-unavailable/);
  assert.deepEqual(await readFile(f.owner), original);
});

test('read does not create leases and an explicitly paused intent cannot acquire one', async (t) => {
  const f = await fixture(t),
    before = await f.store.read();
  await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
  await f.store.update(
    { engineVersion: '0.28.0', runtimeSha256: 'a'.repeat(64) },
    { enabled: false, expectedRevision: before.revision, configuredAt: '2026-10-24T10:01:00.000Z' },
  );
  await assert.rejects(f.store.acquireLease(), /monitor-store-unavailable/);
  await assert.rejects(lstat(f.directory), { code: 'ENOENT' });
});

test('a different live process owns the lease until it explicitly releases', async (t) => {
  const f = await fixture(t);
  const source = `import {createWorkspaceMonitorStore} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'workspace-monitor-store.mjs')).href)};
    const lease = await createWorkspaceMonitorStore(${JSON.stringify(f.config)}).acquireLease();
    if (!lease) process.exit(2); process.stdout.write('owned');
    process.stdin.once('data',async()=>{await lease.release();process.exit(0);});process.stdin.resume();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  let errors = '';
  child.stderr.on('data', (v) => (errors += v));
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(errors));
    });
  });
  await age(f.lock);
  assert.equal(await f.store.acquireLease(), null);
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  child.stdin.write('release');
  assert.equal(await finished, 0, errors);
  const lease = await f.store.acquireLease();
  assert.ok(lease);
  await lease.release();
});

test('an old empty initialization orphan is reclaimed with the existing reaper protocol', async (t) => {
  const f = await fixture(t),
    first = await f.store.acquireLease();
  await first.release();
  await mkdir(f.lock, { mode: 0o700 });
  await age(f.lock);
  const lease = await f.store.acquireLease();
  assert.ok(lease);
  await lease.release();
});

test('foreign-host owner metadata is retained and never guessed dead', async (t) => {
  const f = await fixture(t),
    lease = await f.store.acquireLease();
  assert.ok(lease);
  const owner = JSON.parse(await readFile(f.owner, 'utf8'));
  owner.host = 'different-host.invalid';
  const bytes = Buffer.from(JSON.stringify(owner));
  await writeFile(f.owner, bytes, { mode: 0o600 });
  await age(f.lock);
  await assert.rejects(f.store.acquireLease(), /monitor-store-unavailable/);
  await assert.rejects(lease.release(), /monitor-store-unavailable/);
  assert.deepEqual(await readFile(f.owner), bytes);
});

test('lease namespace remains bounded without deleting orphaned foreign workspaces', async (t) => {
  const f = await fixture(t),
    first = await f.store.acquireLease();
  await first.release();
  for (let i = 0; i < 64; i++)
    await mkdir(join(f.directory, `${hash(`other-${i}`)}.lock`), { mode: 0o700 });
  await assert.rejects(f.store.acquireLease(), /monitor-store-unavailable/);
  await assert.rejects(lstat(f.lock), { code: 'ENOENT' });
  assert.ok((await lstat(join(f.directory, `${hash('other-0')}.lock`))).isDirectory());
});
