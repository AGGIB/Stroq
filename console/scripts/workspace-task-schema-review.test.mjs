import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'tsup';

const directory = await mkdtemp(join(tmpdir(), 'stroq-task-public-boundary-'));
after(() => rm(directory, { recursive: true, force: true }));
await build({
  entry: { schema: join(import.meta.dirname, '../lib/workspace-task-controls.ts') },
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
const schema = await import(pathToFileURL(join(directory, 'schema.mjs')).href);
const sha = 'a'.repeat(64),
  manual = 'b'.repeat(64),
  workspaceId = 'workspace-' + 'a'.repeat(24);
const id = '11111111-1111-4111-8111-111111111111',
  checkId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-10-24T00:00:00.000Z',
  updatedAt = '2026-10-24T00:01:00.000Z';
function record() {
  return {
    id,
    revision: sha,
    workspaceId,
    createdAt,
    updatedAt,
    status: 'manual',
    binding: {
      runId: id,
      captureSha256: sha,
      sourceId: schema.WORKSPACE_TASK_SOURCE_ID,
      sourceSha256: sha,
      sourceMode: 420,
      captureComplete: true,
    },
    originalSha256: sha,
    manualSha256: manual,
    mode: 420,
    changes: { folderOpen: 1, worktreeCreated: 1 },
    fileState: 'manual-version',
    recoveryAvailable: true,
    canRestore: true,
    verification: {
      status: 'recorded',
      runId: checkId,
      captureSha256: manual,
      capturedAt: updatedAt,
      complete: true,
      sourceMatches: true,
    },
    hostEnforcement: false,
  };
}
const receipt = (value) => ({
  schema: 'stroq-workspace-task-receipt/1',
  workspaceId,
  operation: 'recheck',
  checkedAt: '2026-10-24T00:03:00.000Z',
  writeConfirmed: true,
  record: value,
});
const state = (value) => ({
  schema: 'stroq-workspace-task-controls/1',
  workspaceId,
  generatedAt: '2026-10-24T00:03:00.000Z',
  available: true,
  history: 'ready',
  error: null,
  records: [value],
});

test('a confirmed recheck cannot carry an unresolved transaction', () => {
  assert(schema.validateWorkspaceTaskReceipt(receipt(record())));
  for (const status of ['prepared', 'restoring', 'uncertain']) {
    const unresolved = {
      ...record(),
      status,
      fileState: 'unverifiable',
      canRestore: false,
      verification: null,
    };
    assert(
      schema.validateWorkspaceTaskRecord(unresolved),
      'Historical unresolved evidence remains representable',
    );
    assert.equal(
      schema.validateWorkspaceTaskReceipt(receipt(unresolved)),
      false,
      `${status} cannot confirm the file change`,
    );
    assert(schema.validateWorkspaceTaskReceipt({ ...receipt(unresolved), writeConfirmed: false }));
  }
});

test('post-change verification cannot predate the recovery transaction', () => {
  const value = record();
  value.verification.capturedAt = '2026-10-23T23:59:59.999Z';
  assert.equal(schema.validateWorkspaceTaskRecord(value), false);
});

test('record updates cannot predate the verification they retain', () => {
  const value = record();
  value.verification.capturedAt = '2026-10-24T00:01:00.001Z';
  assert.equal(schema.validateWorkspaceTaskRecord(value), false);
});

test('enclosing receipts and snapshots cannot claim capture evidence from their future', () => {
  const value = record();
  value.updatedAt = value.verification.capturedAt = '2026-10-24T00:03:00.001Z';
  assert.equal(schema.validateWorkspaceTaskReceipt(receipt(value)), false);
  assert.equal(schema.validateWorkspaceTaskState(state(value)), false);
});

test('snapshot generation cannot precede the record it presents', () => {
  const value = record();
  value.updatedAt = '2026-10-24T00:03:00.001Z';
  assert.equal(schema.validateWorkspaceTaskState(state(value)), false);
});

test('historical drift, unavailable capture and incomplete evidence stay explicit', () => {
  const changed = {
    ...record(),
    updatedAt: '2026-10-24T00:02:00.000Z',
    fileState: 'changed',
    canRestore: false,
  };
  assert(
    schema.validateWorkspaceTaskRecord(changed),
    'Earlier capture is historical, not current file authority',
  );
  assert(schema.validateWorkspaceTaskState(state(changed)));
  assert(schema.validateWorkspaceTaskReceipt({ ...receipt(changed), writeConfirmed: false }));
  for (const fileState of [
    'changed',
    'missing',
    'unverifiable',
    'original-version',
    'manual-version',
  ]) {
    const manual = { ...record(), fileState, canRestore: false };
    assert(
      schema.validateWorkspaceTaskReceipt({ ...receipt(manual), operation: 'make-manual' }),
      'Confirmed publication is historical even after external file drift',
    );
    assert(schema.validateWorkspaceTaskReceipt(receipt(manual)));
    const restored = { ...manual, status: 'restored' };
    assert(schema.validateWorkspaceTaskReceipt({ ...receipt(restored), operation: 'restore' }));
    assert(schema.validateWorkspaceTaskReceipt(receipt(restored)));
    assert.equal(
      schema.validateWorkspaceTaskReceipt({ ...receipt(restored), operation: 'make-manual' }),
      false,
    );
    assert.equal(
      schema.validateWorkspaceTaskReceipt({ ...receipt(manual), operation: 'restore' }),
      false,
    );
  }
  const unavailable = {
    ...record(),
    verification: { status: 'unavailable', runId: null, error: 'capture-unavailable' },
  };
  assert(schema.validateWorkspaceTaskRecord(unavailable));
  const incomplete = {
    ...record(),
    verification: { ...record().verification, complete: false, sourceMatches: false },
  };
  assert(schema.validateWorkspaceTaskRecord(incomplete));
});
