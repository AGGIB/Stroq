import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, cross } from './codex-path-guard-operations-fixtures.mjs';
import { snapshotFile } from './agent-setup-files.mjs';
const {
  binding: b,
  networkStore: ns,
  networkPlanner: np,
  pathStore: ps,
  pathPlanner: pp,
  pathCapture: pc,
  network: n,
} = cross;
async function networkChild(f) {
  const context = await b.controlContext(f.options),
    before = await b.sourceSnapshot(context),
    id = randomUUID(),
    p = np.planCodexNetworkGuard({ bytes: before.bytes, kind: 'profile-child', operationId: id }),
    native = await f.hooks.nativeCapture(),
    at = new Date().toISOString();
  const m = {
    schema: 'stroq-codex-network-record/1',
    id,
    operationId: randomUUID(),
    controlContextId: context.id,
    rootBinding: context.rootBinding,
    target: context.target,
    sequence: 1,
    ownedKeys: [['default_permissions'], ['permissions', p.owned.childProfile]],
    kind: 'profile-child',
    parentProfile: p.owned.parentProfile,
    childProfile: p.owned.childProfile,
    createdAt: at,
    updatedAt: at,
    phase: 'prepared',
    originalSha256: before.sha256,
    candidateSha256: b.controlHash(p.bytes),
    beforeBytes: before.bytes.length,
    candidateBytes: p.bytes.length,
    mode: before.mode,
    nativeBinarySha256: native.sha256,
    captureSha256: 'a'.repeat(64),
    sourceGraphSha256: 'b'.repeat(64),
    staged: null,
    parents: b.controlParents(before),
    publication: null,
    restoreSha256: null,
    restoreStaged: null,
    restorePublication: null,
  };
  let record = await ns.createNetworkGuardRecord(
    context,
    m,
    before.bytes,
    Buffer.from(p.bytes),
    async () => {},
  );
  await writeFile(f.target, p.bytes);
  const current = await snapshotFile(context.user, context.target, b.CONFIG_BYTES),
    next = {
      ...m,
      phase: 'guarded',
      staged: b.publishedPin(current.file),
      publication: current.file,
    };
  await ns.saveNetworkGuardManifest(context, next, record.revision, async () => {});
  record = await ns.getNetworkGuardRecord(context, id);
  return { context, record };
}
async function retainedPath(f, phase) {
  const c = await pc.capturePathGuard(f.options, f.hooks, 'restore'),
    id = randomUUID(),
    targetPath = join(f.userHome, '.aws/credentials'),
    p = pp.planCodexPathGuard({ bytes: c.before.bytes, operationId: id, targetPath }),
    at = new Date().toISOString();
  const m = {
    schema: 'stroq-codex-path-record/1',
    id,
    operationId: randomUUID(),
    controlContextId: c.context.id,
    rootBinding: c.context.rootBinding,
    target: c.context.target,
    sequence: 1,
    ownedKeys: [['permissions', p.profileName, 'filesystem', targetPath]],
    kind: 'profile-path-deny',
    presetId: 'aws-credentials',
    profileName: p.profileName,
    credentialTarget: targetPath,
    targetMetadataSha256: c.binding.targetMetadataSha256,
    dependencySha256: c.dependencySha256,
    createdAt: at,
    updatedAt: at,
    phase: 'prepared',
    originalSha256: c.before.sha256,
    candidateSha256: b.controlHash(p.bytes),
    beforeBytes: c.before.bytes.length,
    candidateBytes: p.bytes.length,
    mode: c.before.mode,
    nativeBinarySha256: c.native.sha256,
    captureSha256: c.binding.captureSha256,
    sourceGraphSha256: c.binding.sourceGraphSha256,
    staged: null,
    parents: b.controlParents(c.before),
    publication: null,
    restoreSha256: null,
    restoreStaged: null,
    restorePublication: null,
  };
  let r = await ps.createPathGuardRecord(
    c.context,
    m,
    c.before.bytes,
    Buffer.from(p.bytes),
    async () => {},
  );
  await writeFile(f.target, p.bytes);
  const current = await snapshotFile(c.context.user, f.target, b.CONFIG_BYTES),
    guarded = {
      ...m,
      phase: 'guarded',
      staged: b.publishedPin(current.file),
      publication: current.file,
    };
  await ps.savePathGuardManifest(c.context, guarded, r.revision, async () => {});
  r = await ps.getPathGuardRecord(c.context, id);
  if (phase === 'restored') {
    const bytes = pp.restoreCodexPathGuard({ bytes: p.bytes, owned: p.owned });
    await writeFile(f.target, bytes);
    const restored = await snapshotFile(c.context.user, f.target, b.CONFIG_BYTES),
      restoring = {
        ...r.manifest,
        operationId: randomUUID(),
        updatedAt: new Date().toISOString(),
        phase: 'restoring',
        restoreSha256: restored.sha256,
        restoreStaged: b.publishedPin(restored.file),
        restorePublication: null,
      };
    const revision = await ps.savePathGuardManifest(
      c.context,
      restoring,
      r.revision,
      async () => {},
    );
    await ps.savePathGuardManifest(
      c.context,
      { ...restoring, phase: 'restored', restorePublication: restored.file },
      revision,
      async () => {},
    );
    r = await ps.getPathGuardRecord(c.context, id);
  }
  return r;
}
const state = (f) => n.runCodexNetworkGuardOperation('codex-network-state', f.options, {}, f.hooks);
test('real Network child ownership blocks new Path preview before raw retention', async (t) => {
  const f = await fixture(t, { config: 'default_permissions=":danger-full-access"\n' }),
    { record } = await networkChild(f),
    before = await readFile(f.target),
    s = await state(f);
  assert.equal(s.records[0].canRestore, true);
  assert.equal(s.records[0].ownership, 'current');
  await assert.rejects(f.preview(await f.select()), { message: 'codex-path-guard-conflict' });
  assert.deepEqual(await readFile(f.target), before);
  assert.equal((await f.state()).records.length, 0);
  assert.equal((await state(f)).records[0].id, record.manifest.id);
});
test('retained guarded OR restored Path operation permanently blocks older Network selector Restore', async (t) => {
  for (const phase of ['guarded', 'restored'])
    await t.test(phase, async (t) => {
      const f = await fixture(t, { config: 'default_permissions=":danger-full-access"\n' }),
        { record } = await networkChild(f),
        path = await retainedPath(f, phase),
        before = await readFile(f.target),
        s = await state(f),
        row = s.records.find((r) => r.id === record.manifest.id);
      assert.equal(row.ownership, 'superseded');
      assert.equal(row.canRestore, false);
      assert.equal((await f.state()).records[0].operationStatus, phase);
      await assert.rejects(
        n.runCodexNetworkGuardOperation(
          'codex-network-preview',
          f.options,
          {
            request: {
              operation: 'restore',
              controlContextId: row.controlContextId,
              recordId: row.id,
              recordRevision: row.revision,
            },
          },
          f.hooks,
        ),
        { message: 'codex-network-superseded' },
      );
      assert.deepEqual(await readFile(f.target), before);
      assert.equal(
        (await ps.getPathGuardRecord(await b.controlContext(f.options), path.manifest.id)).manifest
          .phase,
        phase,
      );
    });
});
