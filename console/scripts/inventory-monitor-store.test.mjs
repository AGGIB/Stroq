import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
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
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-monitor-store-test-')));
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
const api = await import(pathToFileURL(join(output, 'store.mjs')).href);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const bound = {
  engineVersion: '1.0.0',
  runtimeSha256: 'a'.repeat(64),
  sourceProfileSha256: 'e'.repeat(64),
};
const at = (n) => new Date(Date.UTC(2026, 9, 24, 0, n)).toISOString();
const sources = [
  'claude-skills',
  'agents-skills',
  'codex-skills',
  'cursor-skills',
  'windsurf-skills',
  'devin-skills',
];
async function fixture(t, fault = async () => {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'stroq-monitor-store-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'),
    user = join(directory, 'user'),
    home = join(directory, 'home');
  await mkdir(project, { mode: 0o700 });
  await mkdir(user, { mode: 0o700 });
  const pin = async (path) => {
    const s = await lstat(path);
    return { path, dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode };
  };
  const roots = { project: await pin(project), user: await pin(user) };
  const storeId = hash(`stroq-workspace/1\0${project}\0${roots.project.dev}\0${roots.project.ino}`),
    workspaceId = `workspace-${hash(project).slice(0, 24)}`;
  const store = api.createInventoryMonitorStore({ home, roots, storeId, workspaceId, fault });
  const snap = (sha = 'b'.repeat(64)) => ({
    schema: 'stroq-inventory/1',
    source: 'local',
    generatedAt: at(0),
    workspace: { id: workspaceId, label: 'Fixture' },
    baseline: { status: 'missing', reviewedAt: null },
    items: [
      {
        id: `item-${'b'.repeat(24)}`,
        kind: 'skill',
        name: 'Fixture',
        agent: 'claude-code',
        skillSource: 'claude-skills',
        scope: 'project',
        fileType: 'skill-tree',
        sha256: sha,
        reviewedSha256: null,
        state: 'unreviewed',
        scan: { status: 'clean', findings: 0 },
        capabilities: [],
      },
    ],
    gaps: [],
    limitations: [],
    skillSources: sources.flatMap((id) =>
      ['project', 'user'].map((scope) => ({ id, scope, status: 'complete', candidates: 0 })),
    ),
  });
  let intent;
  const enable = async (runtime = bound) =>
    (intent = await store.updateIntent(runtime, {
      enabled: true,
      expectedRevision: intent?.revision ?? null,
      configuredAt: at(0),
    }));
  const append = (n = 0, sha, extra = {}, runtime = bound) =>
    store.appendObservation(snap(sha), runtime, {
      expectedIntentRevision: intent.revision,
      checkId: randomUUID(),
      observedAt: at(n),
      ...extra,
    });
  return {
    store,
    directory,
    home,
    roots,
    project,
    user,
    storeId,
    workspaceId,
    snap,
    enable,
    append,
    historyFile: join(home, 'console', 'inventory-monitor-observations', `${storeId}.json`),
    intentFile: join(home, 'console', 'inventory-monitor', `${storeId}.json`),
  };
}
test('independent opt-in and missing history read without filesystem writes', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.store.readIntent(), null);
  const history = await f.store.readObservations();
  assert.equal(history.status, 'missing');
  assert.deepEqual(await readdir(f.directory), ['project', 'user']);
  const intent = await f.enable();
  assert.equal(intent.record.schema, 'stroq-inventory-monitor-intent/1');
  assert.equal((await lstat(f.intentFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(f.home, 'console'))).sort(), ['inventory-monitor']);
});
test('accepted unchanged checks coalesce adjacent versions while check ID advances', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const one = await f.append();
  const two = await f.append(1);
  assert.equal(two.record.id, one.record.id);
  assert.equal(two.record.firstObservedAt, at(0));
  assert.equal(two.record.lastObservedAt, at(1));
  assert.notEqual(two.latestCheckId, one.latestCheckId);
  assert.equal(two.latestCaptureId, one.latestCaptureId);
  assert.equal(two.records.length, 1);
  assert.equal((await f.store.readObservations()).latestCheckId, two.latestCheckId);
});
test('A to B to A makes three adjacent versions and compares only predecessor', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const a = await f.append();
  const b = await f.append(1, 'c'.repeat(64));
  const a2 = await f.append(2);
  assert.equal(a2.records.length, 3);
  assert.notEqual(a2.record.id, a.record.id);
  assert.equal(a2.record.changes.fromId, b.record.id);
  assert.equal(a2.record.changes.rows[0].kind, 'changed');
});
test('history evicts oldest versions, preserves omission count and remains bounded', async (t) => {
  const f = await fixture(t);
  await f.enable();
  let result;
  for (let i = 0; i < 18; i++) result = await f.append(i, hash(String(i)));
  assert.equal(result.records.length, 16);
  assert.equal(result.omitted, 2);
  assert.equal(result.records[0].firstObservedAt, at(17));
  assert.equal(result.records.at(-1).firstObservedAt, at(2));
  assert.ok((await lstat(f.historyFile)).size <= 8 * 1024 * 1024);
});
test('new runtime starts an incomparable chain retaining old history', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const first = await f.append();
  const next = { ...bound, runtimeSha256: 'f'.repeat(64) };
  await f.enable(next);
  const result = await f.append(1, undefined, {}, next);
  assert.equal(result.records.length, 2);
  assert.equal(result.record.changes.status, 'runtime-changed');
  assert.equal(result.record.changes.fromId, first.record.id);
  assert.deepEqual(result.record.changes.rows, []);
});
test('malformed history is preserved and never prevents an explicit pause', async (t) => {
  const f = await fixture(t);
  const enabled = await f.enable();
  await f.append();
  const bad = Buffer.from('{"duplicate":1,"duplicate":2}');
  await writeFile(f.historyFile, bad, { mode: 0o600 });
  assert.equal((await f.store.readObservations()).status, 'unavailable');
  await assert.rejects(f.append(1), /observation-store-invalid/);
  assert.deepEqual(await readFile(f.historyFile), bad);
  const paused = await f.store.updateIntent(bound, {
    enabled: false,
    expectedRevision: enabled.revision,
    configuredAt: at(1),
  });
  assert.equal(paused.record.enabled, false);
  assert.deepEqual(await readFile(f.historyFile), bad);
});
test('final commit guard refuses publication preserving last good bytes and IDs', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const first = await f.append();
  const bytes = await readFile(f.historyFile);
  let called = 0;
  await assert.rejects(
    f.append(1, 'c'.repeat(64), {
      beforeCommit: async () => {
        called++;
        throw new Error('runtime-changed');
      },
    }),
    /runtime-changed/,
  );
  assert.equal(called, 1);
  assert.deepEqual(await readFile(f.historyFile), bytes);
  assert.equal((await f.store.readObservations()).latestCheckId, first.latestCheckId);
});
test('disabled or foreign intent and duplicate/older accepted checks cannot append', async (t) => {
  const f = await fixture(t);
  const enabled = await f.enable();
  const first = await f.append(1);
  await assert.rejects(
    f.append(2, undefined, { checkId: first.latestCheckId }),
    /observation-store-stale/,
  );
  await assert.rejects(f.append(0), /observation-store-stale/);
  await f.store.updateIntent(bound, {
    enabled: false,
    expectedRevision: enabled.revision,
    configuredAt: at(2),
  });
  await assert.rejects(f.append(3), /observation-store-stale/);
  assert.equal((await f.store.readObservations()).latestCheckId, first.latestCheckId);
});
test('unsafe history permissions are unavailable and preserve bytes', async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.append();
  const bytes = await readFile(f.historyFile);
  await chmod(f.historyFile, 0o644);
  assert.equal((await f.store.readObservations()).status, 'unavailable');
  await assert.rejects(f.append(1), /observation-store-unavailable/);
  assert.deepEqual(await readFile(f.historyFile), bytes);
});
test('observation history remains writable after growing beyond the configuration one MiB budget', async (t) => {
  const f = await fixture(t);
  const intent = await f.enable();
  const kinds = [
    'fs.read',
    'fs.write',
    'net',
    'cred.env',
    'cred.file',
    'exec',
    'hook',
    'install-script',
    'tool',
    'allowed-tools',
    'signal',
  ];
  const large = (n) => {
    const s = f.snap();
    s.items = Array.from({ length: 512 }, (_, i) => ({
      ...s.items[0],
      id: `item-${i.toString(16).padStart(24, '0')}`,
      name: 'A'.repeat(190),
      location: {
        label: Array(7)
          .fill('folder '.repeat(9) + 'group')
          .join('/'),
        redacted: false,
      },
      sha256: hash(`${n}/${i}`),
      capabilities: kinds.map((kind) => ({ kind, count: 1 })),
    }));
    return s;
  };
  for (let n = 0; n < 3; n++)
    await f.store.appendObservation(large(n), bound, {
      expectedIntentRevision: intent.revision,
      checkId: randomUUID(),
      observedAt: at(n),
    });
  assert.ok((await lstat(f.historyFile)).size > 1024 * 1024);
  assert.equal((await f.store.readObservations()).records.length, 3);
  await f.store.appendObservation(large(3), bound, {
    expectedIntentRevision: intent.revision,
    checkId: randomUUID(),
    observedAt: at(3),
  });
  assert.equal((await f.store.readObservations()).records.length, 4);
});
test('foreign history bytes changed during publication are preserved by the final CAS', async (t) => {
  let active = false,
    target;
  const foreign = Buffer.from('{"foreign":true}');
  const f = await fixture(t, async (stage, details) => {
    if (
      active &&
      stage === 'before-rename' &&
      details.temporary.includes('inventory-monitor-observations')
    ) {
      active = false;
      await writeFile(target, foreign, { mode: 0o600 });
    }
  });
  target = f.historyFile;
  await f.enable();
  await f.append();
  active = true;
  await assert.rejects(f.append(1, 'c'.repeat(64)), /observation-store-stale/);
  assert.deepEqual(await readFile(target), foreign);
});
test('intent changed before the final publication check prevents a late observation', async (t) => {
  let active = false,
    target;
  const f = await fixture(t, async (stage, details) => {
    if (
      active &&
      stage === 'before-rename' &&
      details.temporary.includes('inventory-monitor-observations')
    ) {
      active = false;
      const value = JSON.parse(await readFile(target, 'utf8'));
      value.enabled = false;
      await writeFile(target, JSON.stringify(value) + '\n', { mode: 0o600 });
    }
  });
  target = f.intentFile;
  await f.enable();
  const first = await f.append();
  const bytes = await readFile(f.historyFile);
  active = true;
  await assert.rejects(f.append(1, 'c'.repeat(64)), /observation-store-stale/);
  assert.deepEqual(await readFile(f.historyFile), bytes);
  assert.equal((await f.store.readObservations()).latestCheckId, first.latestCheckId);
});
test('malformed, oversized and unsafe private metadata never replaces existing history', async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.append();
  const good = JSON.parse(await readFile(f.historyFile, 'utf8'));
  const variants = [
    Buffer.from([255]),
    Buffer.alloc(8 * 1024 * 1024 + 1, 32),
    JSON.stringify({ ...good, extra: true }) + '\n',
    JSON.stringify({ ...good, latestCheckId: 'wrong' }) + '\n',
    JSON.stringify(good).replace('"records":', '"records":[],"records":') + '\n',
    JSON.stringify({
      ...good,
      records: [
        {
          ...good.records[0],
          facts: {
            ...good.records[0].facts,
            items: [{ ...good.records[0].facts.items[0], command: 'do not retain raw commands' }],
          },
        },
      ],
    }) + '\n',
  ];
  for (const bytes of variants) {
    await writeFile(f.historyFile, bytes, { mode: 0o600 });
    assert.equal((await f.store.readObservations()).status, 'unavailable');
    await assert.rejects(f.append(1), /observation-store-(invalid|limit)/);
    assert.deepEqual(await readFile(f.historyFile), Buffer.from(bytes));
  }
});
test('canonical home alias observations use their trusted user-only applicability', async (t) => {
  const f = await fixture(t);
  const roots = { project: f.roots.user, user: f.roots.user },
    workspaceId = `workspace-${hash(f.user).slice(0, 24)}`,
    storeId = hash(`stroq-workspace/1\0${f.user}\0${roots.project.dev}\0${roots.project.ino}`);
  const store = api.createInventoryMonitorStore({ home: f.home, roots, workspaceId, storeId });
  const intent = await store.updateIntent(bound, {
    enabled: true,
    expectedRevision: null,
    configuredAt: at(0),
  });
  const snapshot = f.snap();
  snapshot.workspace.id = workspaceId;
  snapshot.items[0].scope = 'user';
  snapshot.skillSources = snapshot.skillSources.filter((s) => s.scope === 'user');
  const result = await store.appendObservation(snapshot, bound, {
    expectedIntentRevision: intent.revision,
    checkId: randomUUID(),
    observedAt: at(0),
  });
  assert.equal(result.record.complete, true);
  assert.equal((await store.readObservations()).records[0].complete, true);
});
test('store refuses self-observing home before enable yet permits pausing a retained old intent', async (t) => {
  const f = await fixture(t);
  const prior = await f.enable();
  const home = join(f.project, '.cursor', 'skills', 'stroq');
  const store = api.createInventoryMonitorStore({
    home,
    roots: f.roots,
    workspaceId: f.workspaceId,
    storeId: f.storeId,
  });
  await assert.rejects(
    store.updateIntent(bound, { enabled: true, expectedRevision: null, configuredAt: at(0) }),
    /context-unavailable/,
  );
  await assert.rejects(lstat(home), { code: 'ENOENT' });
  const directory = join(home, 'console', 'inventory-monitor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify({ ...prior.record, home }) + '\n';
  const file = join(directory, `${f.storeId}.json`);
  await writeFile(file, bytes, { mode: 0o600 });
  const retained = await store.readIntent();
  const paused = await store.updateIntent(bound, {
    enabled: false,
    expectedRevision: retained.revision,
    configuredAt: at(1),
  });
  assert.equal(paused.record.enabled, false);
});
test('replaced project incarnation prevents accepting an observation under the old intent', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const first = await f.append();
  const bytes = await readFile(f.historyFile);
  const { rename } = await import('node:fs/promises');
  await rename(f.project, `${f.project}-old`);
  await mkdir(f.project, { mode: 0o700 });
  await assert.rejects(f.append(1, 'c'.repeat(64)), /observation-store-stale/);
  assert.deepEqual(await readFile(f.historyFile), bytes);
  assert.equal((await f.store.readObservations()).latestCheckId, first.latestCheckId);
});
test('source profile changes require a new intent binding and a separate historical chain', async (t) => {
  const f = await fixture(t);
  await f.enable();
  const first = await f.append();
  const next = { ...bound, sourceProfileSha256: 'f'.repeat(64) };
  await assert.rejects(f.append(1, undefined, {}, next), /observation-store-stale/);
  await f.enable(next);
  const changed = await f.append(1, undefined, {}, next);
  assert.equal(changed.record.runtimeSha256, first.record.runtimeSha256);
  assert.equal(changed.record.changes.status, 'runtime-changed');
  assert.notEqual(changed.record.id, first.record.id);
  const privateHistory = JSON.parse(await readFile(f.historyFile, 'utf8'));
  assert.equal(privateHistory.records[0].sourceProfileSha256, next.sourceProfileSha256);
});
test('old private intent or history without a source profile is preserved and cannot silently resume', async (t) => {
  const f = await fixture(t);
  await f.enable();
  await f.append();
  const history = JSON.parse(await readFile(f.historyFile, 'utf8'));
  delete history.records[0].sourceProfileSha256;
  const oldHistory = JSON.stringify(history) + '\n';
  await writeFile(f.historyFile, oldHistory, { mode: 0o600 });
  assert.equal((await f.store.readObservations()).status, 'unavailable');
  await assert.rejects(f.append(1), /observation-store-invalid/);
  assert.equal(await readFile(f.historyFile, 'utf8'), oldHistory);
  const intent = JSON.parse(await readFile(f.intentFile, 'utf8'));
  delete intent.sourceProfileSha256;
  const oldIntent = JSON.stringify(intent) + '\n';
  await writeFile(f.intentFile, oldIntent, { mode: 0o600 });
  await assert.rejects(f.store.readIntent(), /monitor-store-invalid/);
  await assert.rejects(f.enable(), /monitor-store-invalid/);
  assert.equal(await readFile(f.intentFile, 'utf8'), oldIntent);
});
