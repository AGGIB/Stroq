import assert from 'node:assert/strict';
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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { rootIdentity } from './agent-setup-files.mjs';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-observation-intent-engine-')));
after(() => rm(output, { recursive: true, force: true }));
await build({
  entry: { store: join(repository, 'console/scripts/inventory-monitor-store.ts') },
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
const { createInventoryMonitorStore } = await import(pathToFileURL(join(output, 'store.mjs')).href);

const hash = (v) => createHash('sha256').update(v).digest('hex');
const bound = {
  engineVersion: '0.28.0',
  runtimeSha256: 'a'.repeat(64),
  sourceProfileSha256: 'e'.repeat(64),
};
const at = '2026-10-24T10:00:00.000Z';
async function fixture(t, overrides = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'stroq-monitor-store-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = join(temp, 'project'),
    user = join(temp, 'user');
  await mkdir(project, { mode: 0o700 });
  await mkdir(user, { mode: 0o700 });
  const roots = { project: await rootIdentity(project), user: await rootIdentity(user) };
  const home = join(user, '.stroq');
  const workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  const storeId = hash(`stroq-workspace/1\0${project}\0${roots.project.dev}\0${roots.project.ino}`);
  const config = { home, roots, workspaceId, storeId, ...overrides };
  return {
    temp,
    project,
    user,
    roots,
    home,
    workspaceId,
    storeId,
    config,
    file: join(home, 'console', 'inventory-monitor', `${storeId}.json`),
    store: createInventoryMonitorStore(config),
  };
}
const enable = (f, extra = {}, options = {}) =>
  f.store.updateIntent(
    bound,
    { enabled: true, expectedRevision: null, configuredAt: at, ...extra },
    options,
  );

test('missing reads and context do not create a home; only explicit enable creates private intent', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.store.readIntent(), null);
  assert.equal((await f.store.context()).home, f.home);
  await assert.rejects(lstat(f.home), { code: 'ENOENT' });
  const first = await enable(f);
  assert.equal(first.revision, hash(await readFile(f.file)));
  assert.equal(first.record.enabled, true);
  assert.deepEqual(first.record.roots, f.roots);
  assert.equal(first.record.runtimeSha256, bound.runtimeSha256);
  for (const path of [
    f.home,
    join(f.home, 'console'),
    join(f.home, 'console', 'inventory-monitor'),
  ])
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await createInventoryMonitorStore(f.config).readIntent(), first);
  const paused = await f.store.updateIntent(bound, {
    enabled: false,
    expectedRevision: first.revision,
    configuredAt: '2026-10-24T10:01:00.000Z',
  });
  assert.equal(paused.record.enabled, false);
  assert.notEqual(paused.revision, first.revision);
  assert.deepEqual(await f.store.readIntent(), paused);
});

test('revision is stable across reads and stale enable/pause never overwrites', async (t) => {
  const f = await fixture(t),
    first = await enable(f);
  for (let i = 0; i < 3; i++) assert.deepEqual(await f.store.readIntent(), first);
  await assert.rejects(enable(f), /monitor-store-stale/);
  await assert.rejects(
    f.store.updateIntent(bound, {
      enabled: false,
      expectedRevision: 'b'.repeat(64),
      configuredAt: at,
    }),
    /monitor-store-stale/,
  );
  assert.deepEqual(await f.store.readIntent(), first);
});

test('read retains historical binding and pause remains possible after project replacement', async (t) => {
  const f = await fixture(t),
    first = await enable(f);
  await rename(f.project, `${f.project}-old`);
  await mkdir(f.project, { mode: 0o700 });
  assert.deepEqual(await f.store.readIntent(), first);
  await assert.rejects(enable(f, { expectedRevision: first.revision }), /monitor-store-stale/);
  const paused = await f.store.updateIntent(
    {
      engineVersion: 'different',
      runtimeSha256: 'b'.repeat(64),
      sourceProfileSha256: 'f'.repeat(64),
    },
    { enabled: false, expectedRevision: first.revision, configuredAt: at },
  );
  assert.equal(paused.record.enabled, false);
  assert.deepEqual(paused.record.roots, first.record.roots);
  assert.equal(paused.record.runtimeSha256, first.record.runtimeSha256);
});

for (const [name, transform] of [
  ['malformed JSON', () => '{'],
  [
    'duplicate decoded keys',
    (s) => s.replace('"enabled":true', '"enabled":false,"enable\\u0064":true'),
  ],
  ['unknown fields', (s) => s.replace('"enabled":true', '"enabled":true,"extra":0')],
  ['invalid Unicode', (s) => s.replace('0.28.0', '\\ud800')],
  ['invalid UTF-8', () => Buffer.from([0xff, 0xfe])],
  ['oversized bytes', () => ' '.repeat(8193)],
])
  test(`${name} remains unavailable and cannot be reset by configure`, async (t) => {
    const f = await fixture(t);
    await enable(f);
    const bytes = transform(await readFile(f.file, 'utf8'));
    await writeFile(f.file, bytes, { mode: 0o600 });
    await assert.rejects(f.store.readIntent(), /monitor-store-(?:invalid|limit)/);
    await assert.rejects(enable(f), /monitor-store-(?:invalid|limit)/);
    assert.deepEqual(await readFile(f.file), Buffer.from(bytes));
  });

for (const kind of [
  'file-mode',
  'parent-mode',
  'file-symlink',
  'file-hardlink',
  'home-symlink',
  'directory-symlink',
])
  test(`unsafe ${kind} is refused without writing`, async (t) => {
    const f = await fixture(t);
    const first = await enable(f);
    if (kind === 'file-mode') await chmod(f.file, 0o644);
    if (kind === 'parent-mode') await chmod(join(f.home, 'console', 'inventory-monitor'), 0o755);
    if (kind === 'file-hardlink') await link(f.file, join(f.temp, 'foreign-link'));
    if (kind === 'file-symlink') {
      await rename(f.file, `${f.file}.original`);
      await symlink(`${f.file}.original`, f.file);
    }
    if (kind === 'home-symlink') {
      await rename(f.home, `${f.home}-old`);
      await symlink(`${f.home}-old`, f.home);
    }
    if (kind === 'directory-symlink') {
      const path = join(f.home, 'console', 'inventory-monitor');
      await rename(path, `${path}-old`);
      await symlink(`${path}-old`, path);
    }
    await assert.rejects(f.store.readIntent(), /monitor-store-unavailable/);
    await assert.rejects(
      enable(f, { expectedRevision: first.revision }),
      /monitor-store-unavailable/,
    );
  });

test('last moment guard rejection and concurrent foreign writes do not publish or roll back foreign state', async (t) => {
  const f = await fixture(t),
    first = await enable(f);
  await assert.rejects(
    f.store.updateIntent(
      bound,
      { enabled: false, expectedRevision: first.revision, configuredAt: at },
      {
        beforeCommit() {
          throw new Error('guard-rejected');
        },
      },
    ),
    /guard-rejected/,
  );
  assert.deepEqual(await f.store.readIntent(), first);
  let called = 0;
  const foreign = Buffer.from(
    (await readFile(f.file, 'utf8')).replace('"enabled":true', '"enabled":false'),
  );
  await assert.rejects(
    enable(
      f,
      { expectedRevision: first.revision },
      {
        async beforeCommit() {
          called++;
          await writeFile(f.file, foreign, { mode: 0o600 });
        },
      },
    ),
    /monitor-store-stale/,
  );
  assert.equal(called, 1);
  assert.deepEqual(await readFile(f.file), foreign);
});

test('parent replacement during staged write is refused and foreign replacement is retained', async (t) => {
  let f,
    replaced = false;
  f = await fixture(t, {
    async fault(stage) {
      if (stage !== 'before-rename' || replaced) return;
      replaced = true;
      const path = join(f.home, 'console', 'inventory-monitor');
      await rename(path, `${path}-old`);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, 'foreign'), 'keep', { mode: 0o600 });
    },
  });
  await assert.rejects(enable(f), /monitor-store-(?:stale|unavailable)/);
  assert.equal(
    await readFile(join(f.home, 'console', 'inventory-monitor', 'foreign'), 'utf8'),
    'keep',
  );
});

test('post-publication failures are explicit uncertainty and never restore an older value', async (t) => {
  const f = await fixture(t, {
    fault(stage) {
      if (stage === 'after-rename') throw new Error('fault');
    },
  });
  await assert.rejects(enable(f), /monitor-store-write-unconfirmed/);
  assert.equal((await f.store.readIntent()).record.enabled, true);
});

test('record count is capped without pruning existing workspace intents', async (t) => {
  const f = await fixture(t),
    first = await enable(f);
  const directory = join(f.home, 'console', 'inventory-monitor');
  const identities = [];
  for (let i = 1; i < 64; i++) {
    const project = join(f.temp, `project-${i}`);
    await mkdir(project, { mode: 0o700 });
    const root = await rootIdentity(project);
    const storeId = hash(`stroq-workspace/1\0${project}\0${root.dev}\0${root.ino}`);
    const record = {
      ...first.record,
      storeId,
      workspaceId: `workspace-${hash(project).slice(0, 24)}`,
      roots: { ...f.roots, project: root },
    };
    await writeFile(join(directory, `${storeId}.json`), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    identities.push(storeId);
  }
  const project = join(f.temp, 'sixty-five');
  await mkdir(project, { mode: 0o700 });
  const root = await rootIdentity(project);
  const storeId = hash(`stroq-workspace/1\0${project}\0${root.dev}\0${root.ino}`);
  const store = createInventoryMonitorStore({
    ...f.config,
    storeId,
    workspaceId: `workspace-${hash(project).slice(0, 24)}`,
    roots: { ...f.roots, project: root },
  });
  await assert.rejects(
    store.updateIntent(bound, { enabled: true, expectedRevision: null, configuredAt: at }),
    /monitor-store-limit/,
  );
  assert.equal((await f.store.readIntent()).revision, first.revision);
  for (const id of identities) assert.ok((await lstat(join(directory, `${id}.json`))).isFile());
});

test('a newly added intent during staging fails closed without pruning it', async (t) => {
  let f,
    added = false,
    otherPath;
  f = await fixture(t, {
    async fault(stage) {
      if (stage !== 'before-rename' || added) return;
      added = true;
      const project = join(f.temp, 'other-project');
      await mkdir(project, { mode: 0o700 });
      const root = await rootIdentity(project);
      const storeId = hash(`stroq-workspace/1\0${project}\0${root.dev}\0${root.ino}`);
      otherPath = join(f.home, 'console', 'inventory-monitor', `${storeId}.json`);
      const record = {
        schema: 'stroq-inventory-monitor-intent/1',
        storeId,
        workspaceId: `workspace-${hash(project).slice(0, 24)}`,
        home: f.home,
        roots: { ...f.roots, project: root },
        ...bound,
        configuredAt: at,
        enabled: true,
      };
      await writeFile(otherPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    },
  });
  await assert.rejects(enable(f), /monitor-store-stale/);
  await assert.rejects(lstat(f.file), { code: 'ENOENT' });
  assert.ok((await lstat(otherPath)).isFile());
});

test('missing project at commit requires new context while a retained intent can still be paused', async (t) => {
  const f = await fixture(t),
    first = await enable(f);
  await rename(f.project, `${f.project}-gone`);
  await assert.rejects(enable(f, { expectedRevision: first.revision }), /monitor-store-stale/);
  const paused = await f.store.updateIntent(bound, {
    enabled: false,
    expectedRevision: first.revision,
    configuredAt: at,
  });
  assert.equal(paused.record.enabled, false);
});

test('unrecognized filenames and lossy identity numbers are never silently discarded', async (t) => {
  const f = await fixture(t),
    first = await enable(f);
  const foreign = join(f.home, 'console', 'inventory-monitor', 'unrecognized.json');
  await writeFile(foreign, '{}', { mode: 0o600 });
  await assert.rejects(f.store.readIntent(), /monitor-store-invalid/);
  await assert.rejects(enable(f, { expectedRevision: first.revision }), /monitor-store-invalid/);
  assert.equal(await readFile(foreign, 'utf8'), '{}');
  await rm(foreign);
  const original = await readFile(f.file, 'utf8');
  await writeFile(f.file, original.replace(/"dev":(\d+)/, '"dev":$1.00000000000000000001'));
  await assert.rejects(f.store.readIntent(), /monitor-store-invalid/);
});
