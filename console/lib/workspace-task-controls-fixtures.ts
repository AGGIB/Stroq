import {
  WORKSPACE_TASK_SOURCE_ID,
  type WorkspaceTaskBinding,
  type WorkspaceTaskPreview,
  type WorkspaceTaskRecord,
  type WorkspaceTaskReceipt,
  type WorkspaceTaskState,
} from './workspace-task-controls';
import { deriveWorkspaceReviewComparison, type WorkspaceReviewRun } from './workspace-review';

export const taskSha = (digit: string) => digit.repeat(64);
export const taskId = '11111111-1111-4111-8111-111111111111';
export const taskAt = '2026-10-24T10:00:00.000Z';
export const taskWs = `workspace-${'a'.repeat(24)}`;
export function taskBinding(): WorkspaceTaskBinding {
  return {
    runId: taskId,
    captureSha256: taskSha('a'),
    sourceId: WORKSPACE_TASK_SOURCE_ID,
    sourceSha256: taskSha('b'),
    sourceMode: 420,
    captureComplete: true,
  };
}
export function taskRun(): WorkspaceReviewRun {
  const binding = taskBinding();
  const baseline = { status: 'missing' as const, revision: null, reviewedAt: null, capture: null };
  const capture = {
    schema: 'stroq-workspace-capture/1' as const,
    workspaceId: taskWs,
    captureSha256: binding.captureSha256,
    capturedAt: taskAt,
    profile: {
      id: 'stroq-workspace-surface/1' as const,
      engineVersion: '0.28.0',
      runtimeSha256: taskSha('c'),
      scopeSha256: taskSha('d'),
    },
    complete: true,
    coverage: { omittedSources: 0, omittedEntries: 0, exclusions: [], gaps: [] },
    sources: [
      {
        id: binding.sourceId,
        label: '.vscode/tasks.json',
        labelHidden: false,
        kind: 'file' as const,
        role: 'workspace' as const,
        sha256: binding.sourceSha256,
        mode: binding.sourceMode,
      },
    ],
    entries: [
      {
        id: `entry-${taskSha('e')}`,
        sourceId: binding.sourceId,
        kind: 'editor-autorun-task' as const,
        stage: 'on-open' as const,
        severity: 'error' as const,
        line: 4,
        count: 2,
        semanticSha256: taskSha('f'),
      },
    ],
  };
  return {
    schema: 'stroq-workspace-review-run/1',
    id: taskId,
    workspaceId: taskWs,
    status: 'completed',
    startedAt: taskAt,
    finishedAt: taskAt,
    result: {
      capture,
      baseline,
      comparison: deriveWorkspaceReviewComparison(capture, baseline),
      canReview: true,
    },
  };
}
export function taskRecord(): WorkspaceTaskRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    revision: taskSha('1'),
    workspaceId: taskWs,
    createdAt: taskAt,
    updatedAt: taskAt,
    status: 'manual',
    binding: taskBinding(),
    originalSha256: taskSha('b'),
    manualSha256: taskSha('2'),
    mode: 420,
    changes: { folderOpen: 2, worktreeCreated: 1 },
    fileState: 'manual-version',
    recoveryAvailable: true,
    canRestore: true,
    verification: null,
    hostEnforcement: false,
  };
}
export function taskPreview(
  operation: WorkspaceTaskPreview['operation'] = 'make-manual',
): WorkspaceTaskPreview {
  const record = taskRecord();
  return {
    schema: 'stroq-workspace-task-preview/1',
    id: '33333333-3333-4333-8333-333333333333',
    workspaceId: taskWs,
    operation,
    recordId: record.id,
    recordRevision: operation === 'restore' ? record.revision : null,
    createdAt: taskAt,
    expiresAt: '2026-10-24T10:02:00.000Z',
    binding: record.binding,
    beforeSha256: operation === 'restore' ? record.manualSha256 : record.originalSha256,
    afterSha256: operation === 'restore' ? record.originalSha256 : record.manualSha256,
    changes: record.changes,
    sourceMode: record.mode,
    manualTasksPreserved: true,
    formattingPreserved: true,
    completeFileBackup: true,
    hostEnforcement: false,
  };
}
export function taskState(records: WorkspaceTaskRecord[] = []): WorkspaceTaskState {
  return {
    schema: 'stroq-workspace-task-controls/1',
    workspaceId: taskWs,
    generatedAt: taskAt,
    available: true,
    history: records.length ? 'ready' : 'missing',
    error: null,
    records,
  };
}
export function taskReceipt(
  operation: WorkspaceTaskReceipt['operation'] = 'make-manual',
): WorkspaceTaskReceipt {
  const record = taskRecord();
  if (operation === 'restore') {
    record.status = 'restored';
    record.fileState = 'original-version';
    record.canRestore = false;
  }
  return {
    schema: 'stroq-workspace-task-receipt/1',
    workspaceId: taskWs,
    operation,
    checkedAt: taskAt,
    writeConfirmed: true,
    record,
  };
}
