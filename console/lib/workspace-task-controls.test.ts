import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_TASK_SOURCE_ID,
  validateWorkspaceTaskPreview,
  validateWorkspaceTaskRecord,
  validateWorkspaceTaskReceipt,
  validateWorkspaceTaskState,
  type WorkspaceTaskPreview,
  type WorkspaceTaskRecord,
} from './workspace-task-controls';

const sha = 'a'.repeat(64),
  other = 'b'.repeat(64);
const ws = `workspace-${'a'.repeat(24)}`;
const id = '11111111-1111-4111-8111-111111111111';
const at = '2026-10-24T00:00:00.000Z';
function record(): WorkspaceTaskRecord {
  return {
    id,
    revision: sha,
    workspaceId: ws,
    createdAt: at,
    updatedAt: at,
    status: 'manual',
    binding: {
      runId: id,
      captureSha256: sha,
      sourceId: WORKSPACE_TASK_SOURCE_ID,
      sourceSha256: sha,
      sourceMode: 420,
      captureComplete: true,
    },
    originalSha256: sha,
    manualSha256: other,
    mode: 420,
    changes: { folderOpen: 1, worktreeCreated: 1 },
    fileState: 'manual-version',
    recoveryAvailable: true,
    canRestore: true,
    verification: null,
    hostEnforcement: false,
  };
}
function preview(): WorkspaceTaskPreview {
  return {
    schema: 'stroq-workspace-task-preview/1',
    id,
    workspaceId: ws,
    operation: 'make-manual',
    recordId: id,
    recordRevision: null,
    createdAt: at,
    expiresAt: '2026-10-24T00:02:00.000Z',
    binding: record().binding,
    beforeSha256: sha,
    afterSha256: other,
    changes: record().changes,
    sourceMode: 420,
    manualTasksPreserved: true,
    formattingPreserved: true,
    completeFileBackup: true,
    hostEnforcement: false,
  };
}

describe('workspace task control public boundary', () => {
  it('accepts both triggers, restore direction and explicit incomplete capture evidence', () => {
    expect(validateWorkspaceTaskPreview(preview())).toBe(true);
    expect(validateWorkspaceTaskRecord(record())).toBe(true);
    expect(
      validateWorkspaceTaskPreview({
        ...preview(),
        operation: 'restore',
        recordRevision: sha,
        beforeSha256: other,
        afterSha256: sha,
      }),
    ).toBe(true);
    expect(
      validateWorkspaceTaskRecord({
        ...record(),
        binding: { ...record().binding, captureComplete: false },
        verification: {
          status: 'recorded',
          runId: id,
          captureSha256: other,
          capturedAt: at,
          complete: false,
          sourceMatches: true,
        },
      }),
    ).toBe(true);
  });

  it('refuses raw fields, wrong source, zero/fractional/overflow counts and false invariants', () => {
    const value = preview();
    for (const bad of [
      { ...value, command: 'private' },
      { ...value, path: '.vscode/tasks.json' },
      { ...value, binding: { ...value.binding, sourceId: `source-${sha}` } },
      { ...value, changes: { folderOpen: 0, worktreeCreated: 0 } },
      { ...value, changes: { folderOpen: 1.5, worktreeCreated: 0 } },
      { ...value, changes: { folderOpen: 256, worktreeCreated: 1 } },
      { ...value, changes: { folderOpen: 1, worktreeCreated: 1, taskName: 'private' } },
      { ...value, sourceMode: 511 },
      { ...value, formattingPreserved: false },
      { ...value, hostEnforcement: true },
      { ...value, completeFileBackup: false },
    ])
      expect(validateWorkspaceTaskPreview(bad)).toBe(false);
  });

  it('refuses expired shape, reversed writes, reused previews and disconnected hashes', () => {
    const value = preview();
    for (const bad of [
      { ...value, expiresAt: at },
      { ...value, expiresAt: '2026-10-24T00:02:00.001Z' },
      { ...value, recordRevision: sha },
      { ...value, afterSha256: sha },
      { ...value, beforeSha256: other, afterSha256: sha },
      { ...value, operation: 'restore', recordRevision: null },
      { ...value, operation: 'restore', recordRevision: sha, afterSha256: other },
    ])
      expect(validateWorkspaceTaskPreview(bad)).toBe(false);
  });

  it('rejects contradictory recovery permission, mode, timestamps and unknown evidence', () => {
    const value = record();
    for (const bad of [
      { ...value, originalSha256: other },
      { ...value, manualSha256: sha },
      { ...value, mode: 384 },
      { ...value, updatedAt: '2026-10-23T23:59:59.999Z' },
      { ...value, canRestore: true, recoveryAvailable: false },
      { ...value, status: 'prepared', canRestore: true },
      { ...value, fileState: 'changed', canRestore: true },
      { ...value, fileState: 'same-hash' },
      { ...value, verification: { status: 'unavailable', runId: null, error: 'raw-error' } },
      {
        ...value,
        verification: {
          status: 'recorded',
          runId: id,
          captureSha256: sha,
          capturedAt: at,
          complete: true,
          sourceMatches: true,
          raw: 'private',
        },
      },
    ])
      expect(validateWorkspaceTaskRecord(bad)).toBe(false);
    expect(
      validateWorkspaceTaskRecord({
        ...value,
        status: 'uncertain',
        fileState: 'unverifiable',
        canRestore: false,
        verification: { status: 'unavailable', runId: null, error: 'capture-unavailable' },
      }),
    ).toBe(true);
  });

  it('refuses foreign/duplicate history and contradictory availability without creating history', () => {
    const value = {
      schema: 'stroq-workspace-task-controls/1',
      workspaceId: ws,
      generatedAt: at,
      available: true,
      history: 'ready',
      error: null,
      records: [record()],
    };
    expect(validateWorkspaceTaskState(value)).toBe(true);
    expect(validateWorkspaceTaskState({ ...value, history: 'missing', records: [] })).toBe(true);
    expect(
      validateWorkspaceTaskState({
        ...value,
        available: false,
        history: 'unavailable',
        error: 'runtime-unavailable',
      }),
    ).toBe(true);
    for (const bad of [
      { ...value, records: [record(), record()] },
      { ...value, records: [{ ...record(), workspaceId: `workspace-${'b'.repeat(24)}` }] },
      { ...value, history: 'missing' },
      { ...value, error: 'history-unavailable' },
      { ...value, available: false },
      { ...value, history: 'unavailable' },
      { ...value, records: Array.from({ length: 33 }, () => record()) },
    ])
      expect(validateWorkspaceTaskState(bad)).toBe(false);
  });

  it('keeps confirmed file writes independent of unavailable static capture', () => {
    const value = {
      schema: 'stroq-workspace-task-receipt/1',
      workspaceId: ws,
      operation: 'make-manual',
      checkedAt: at,
      writeConfirmed: true,
      record: {
        ...record(),
        verification: { status: 'unavailable', runId: null, error: 'capture-unavailable' },
      },
    };
    expect(validateWorkspaceTaskReceipt(value)).toBe(true);
    expect(validateWorkspaceTaskReceipt({ ...value, operation: 'restore' })).toBe(false);
    expect(validateWorkspaceTaskReceipt({ ...value, writeConfirmed: false })).toBe(false);
    expect(validateWorkspaceTaskReceipt({ ...value, checkedAt: '2026-10-23T00:00:00.000Z' })).toBe(
      false,
    );
    expect(
      validateWorkspaceTaskReceipt({ ...value, operation: 'recheck', writeConfirmed: false }),
    ).toBe(true);
  });
});
