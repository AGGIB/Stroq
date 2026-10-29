import { describe, expect, it } from 'vitest';
import {
  taskBinding,
  taskPreview,
  taskReceipt,
  taskRecord,
  taskRun,
  taskSha,
  taskWs,
} from './workspace-task-controls-fixtures';
import {
  workspaceTaskBindingFor,
  workspaceTaskPreviewMatches,
  workspaceTaskReceiptMatches,
  workspaceTaskRecordSelection,
  workspaceTaskRecoveryHref,
} from './workspace-task-controls-binding';

describe('workspace task exact source and recovery binding', () => {
  it('binds only the captured fixed task file with an actual on-open automatic-task signal', () => {
    const run = taskRun();
    const source = run.result!.capture.sources[0]!;
    expect(workspaceTaskBindingFor(run, source)).toEqual(taskBinding());
    expect(workspaceTaskBindingFor(run, { ...source, sha256: taskSha('9') })).toBeNull();
    run.result!.capture.sources[0] = { ...source, kind: 'link' };
    expect(workspaceTaskBindingFor(run, source)).toBeNull();
    run.result!.capture.sources[0] = source;
    run.result!.capture.entries = [];
    expect(workspaceTaskBindingFor(run, source)).toBeNull();
  });
  it('refuses a typed preview bound to another capture, source version or restoration record', () => {
    const preview = taskPreview();
    expect(workspaceTaskPreviewMatches(preview, taskBinding(), taskWs)).toBe(true);
    expect(
      workspaceTaskPreviewMatches(
        { ...preview, binding: { ...preview.binding, captureSha256: taskSha('9') } },
        taskBinding(),
        taskWs,
      ),
    ).toBe(false);
    expect(
      workspaceTaskPreviewMatches(
        { ...preview, binding: { ...preview.binding, sourceMode: 384 }, sourceMode: 384 },
        taskBinding(),
        taskWs,
      ),
    ).toBe(false);
    const restore = taskPreview('restore');
    expect(workspaceTaskPreviewMatches(restore, taskBinding(), taskWs, taskRecord())).toBe(true);
    expect(
      workspaceTaskPreviewMatches(restore, taskBinding(), taskWs, {
        ...taskRecord(),
        revision: taskSha('9'),
      }),
    ).toBe(false);
  });
  it('accepts confirmed file writes with unavailable capture but rejects mismatched or pre-attempt receipts', () => {
    const receipt = taskReceipt();
    receipt.record.verification = {
      status: 'unavailable',
      runId: null,
      error: 'capture-unavailable',
    };
    expect(workspaceTaskReceiptMatches(receipt, taskPreview(), '2026-10-24T10:00:00.000Z')).toBe(
      true,
    );
    expect(workspaceTaskReceiptMatches(receipt, taskPreview(), '2026-10-24T10:00:00.001Z')).toBe(
      false,
    );
    expect(
      workspaceTaskReceiptMatches(
        {
          ...receipt,
          record: { ...receipt.record, changes: { folderOpen: 1, worktreeCreated: 1 } },
        },
        taskPreview(),
        receipt.checkedAt,
      ),
    ).toBe(false);
    expect(
      workspaceTaskReceiptMatches(taskReceipt('restore'), taskPreview(), receipt.checkedAt),
    ).toBe(false);
  });
  it('preserves exact recovery links and rejects duplicated, malformed or absent selections', () => {
    const record = taskRecord();
    const href = workspaceTaskRecoveryHref(record);
    const query = new URLSearchParams(href.split('?')[1]);
    expect(query.get('run')).toBe(record.binding.runId);
    expect(query.get('workspace')).toBe(taskWs);
    expect(workspaceTaskRecordSelection(query)).toEqual({
      requested: true,
      invalid: false,
      recordId: record.id,
    });
    query.append('taskControl', record.id);
    expect(workspaceTaskRecordSelection(query).invalid).toBe(true);
    expect(workspaceTaskRecordSelection(new URLSearchParams('taskControl=private')).invalid).toBe(
      true,
    );
    expect(workspaceTaskRecordSelection(new URLSearchParams())).toEqual({
      requested: false,
      invalid: false,
      recordId: null,
    });
  });
});
