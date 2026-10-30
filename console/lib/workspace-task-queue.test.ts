import { describe, expect, it } from 'vitest';
import { workspaceTaskRows, WORKSPACE_TASK_ATTENTION_LIMIT } from './workspace-task-queue';
import { validateWorkspaceTaskState, type WorkspaceTaskRecord } from './workspace-task-controls';
import { workspaceTaskRecoveryHref } from './workspace-task-controls-binding';
import {
  taskAt,
  taskId,
  taskRecord,
  taskSha,
  taskState,
  taskWs,
} from './workspace-task-controls-fixtures';
function confirmed(status: 'manual' | 'restored' | 'unchanged' = 'manual'): WorkspaceTaskRecord {
  return {
    ...taskRecord(),
    status,
    fileState: status === 'manual' ? 'manual-version' : 'original-version',
    canRestore: status === 'manual',
    verification:
      status === 'unchanged'
        ? null
        : {
            status: 'recorded',
            runId: taskId,
            captureSha256: taskSha('9'),
            capturedAt: taskAt,
            complete: true,
            sourceMatches: true,
          },
  };
}
function rows(record: WorkspaceTaskRecord) {
  const state = taskState([record]);
  expect(validateWorkspaceTaskState(state)).toBe(true);
  return workspaceTaskRows(state, taskWs);
}
describe('task recovery in the Protection queue', () => {
  it('keeps confirmed matching manual/restored/unchanged phases quiet, including legitimate canRestore:false', () => {
    for (const status of ['manual', 'restored', 'unchanged'] as const) {
      expect(rows(confirmed(status))).toEqual([]);
      expect(rows({ ...confirmed(status), canRestore: false })).toEqual([]);
    }
    expect(workspaceTaskRows(taskState(), taskWs)).toEqual([]);
  });
  it.each(['prepared', 'restoring', 'uncertain'] as const)(
    'routes %s to the exact retained change before any capture or file-state reason',
    (status) => {
      const record = {
        ...confirmed(),
        status,
        fileState: 'changed' as const,
        canRestore: false,
        recoveryAvailable: false,
      };
      const [row] = rows(record);
      expect(row?.key).toBe(`workspace-task:${record.id}`);
      expect(row?.title).toBe('Task change needs recheck');
      expect(row?.href).toBe(workspaceTaskRecoveryHref(record));
      expect(row?.action).toBe('Inspect change');
      expect(row?.tone).toBe('orange');
      expect(row?.detail).toContain('Completion is unverified');
      expect(row?.detail).not.toContain('File change confirmed');
    },
  );
  it.each([
    ['changed', 'Task file changed after recorded action'],
    ['missing', 'Task file missing'],
    ['unverifiable', 'Current task file unverified'],
  ] as const)(
    'keeps %s current file evidence separate from successful historical publication',
    (fileState, title) => {
      const record = { ...confirmed(), fileState, canRestore: false };
      const result = rows(record);
      expect(result).toHaveLength(1);
      expect(result[0]?.title).toBe(title);
      expect(result[0]?.detail).toContain('File change recorded');
      expect(result[0]?.detail).not.toContain('Completion is unverified');
    },
  );
  it('flags current-version disagreement for all conclusive phases without guessing who edited the file', () => {
    for (const status of ['manual', 'restored', 'unchanged'] as const) {
      const record = confirmed(status);
      record.fileState = status === 'manual' ? 'original-version' : 'manual-version';
      record.canRestore = false;
      expect(rows(record)[0]?.title).toBe('Task file differs from recorded result');
    }
  });
  it.each(['manual', 'restored', 'unchanged'] as const)(
    'shows lost recovery evidence for historical %s without calling the action unfinished',
    (status) => {
      const record = { ...confirmed(status), recoveryAvailable: false, canRestore: false };
      const [row] = rows(record);
      expect(row?.title).toBe('Task recovery copy unavailable');
      expect(row?.detail).not.toContain('Completion is unverified');
    },
  );
  it('uses missing/unavailable capture follow-up for successful writes, while unchanged with no capture remains a no-write result', () => {
    for (const status of ['manual', 'restored'] as const) {
      const record = { ...confirmed(status), verification: null };
      expect(rows(record)[0]?.title).toBe('Task change needs static verification');
    }
    for (const status of ['manual', 'restored', 'unchanged'] as const) {
      const record = {
        ...confirmed(status),
        verification: {
          status: 'unavailable' as const,
          runId: null,
          error: 'capture-unavailable' as const,
        },
      };
      expect(rows(record)[0]?.title).toBe('Task verification unavailable');
    }
    expect(rows(confirmed('unchanged'))).toEqual([]);
  });
  it.each(['manual', 'restored', 'unchanged'] as const)(
    'preserves partial and unmatched source verification for %s with exact-record links',
    (status) => {
      const record = confirmed(status);
      record.verification = {
        status: 'recorded',
        runId: taskId,
        captureSha256: taskSha('9'),
        capturedAt: taskAt,
        complete: false,
        sourceMatches: true,
      };
      expect(rows(record)[0]?.title).toBe('Workspace verification incomplete');
      expect(rows(record)[0]?.href).toBe(workspaceTaskRecoveryHref(record));
      record.verification.sourceMatches = false;
      expect(rows(record)[0]?.title).toBe('Task source not verified by capture');
      record.verification.complete = true;
      expect(rows(record)[0]?.title).toBe('Task source not verified by capture');
      record.verification.sourceMatches = true;
      expect(rows(record)).toEqual([]);
    },
  );
  it('uses one highest-priority reason per record: unfinished, file evidence, recovery, then verification', () => {
    const record = {
      ...confirmed(),
      recoveryAvailable: false,
      canRestore: false,
      verification: null,
    };
    expect(rows(record)[0]?.title).toBe('Task recovery copy unavailable');
    record.fileState = 'missing';
    expect(rows(record)[0]?.title).toBe('Task file missing');
  });
  it('refuses missing, wrong-workspace, unavailable and malformed history without interpreting it as no tasks', () => {
    const foreign = `workspace-${'f'.repeat(24)}`;
    const cases: [unknown, string][] = [
      [null, taskWs],
      [taskState([confirmed()]), foreign],
      [
        { ...taskState(), available: false, history: 'unavailable', error: 'history-unavailable' },
        taskWs,
      ],
      [{ ...taskState(), rawPath: '/PRIVATE' }, taskWs],
      [
        { ...taskState([confirmed()]), records: [{ ...confirmed(), workspaceId: foreign }] },
        taskWs,
      ],
      [taskState([confirmed(), confirmed()]), taskWs],
      [
        taskState([
          {
            ...confirmed(),
            binding: { ...confirmed().binding, sourceId: `source-${taskSha('f')}` },
          } as WorkspaceTaskRecord,
        ]),
        taskWs,
      ],
    ];
    for (const [state, workspaceId] of cases) {
      const result = workspaceTaskRows(state, workspaceId);
      expect(result).toHaveLength(1);
      expect(result[0]?.key).toBe('workspace-task-history');
      expect(result[0]?.title).toBe('Task change history unavailable');
      expect(result[0]?.href).toBe('/protection/workspace/');
    }
    expect(workspaceTaskRows(taskState(), null)[0]?.key).toBe('workspace-task-history');
  });
  it('bounds individual records and links overflow to the first omitted exact record in deterministic priority order', () => {
    const records = Array.from({ length: 9 }, (_, index) => ({
      ...confirmed(),
      id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      status: 'uncertain' as const,
      canRestore: false,
    }));
    const state = taskState(records.toReversed());
    const before = JSON.stringify(state);
    const result = workspaceTaskRows(state, taskWs);
    expect(WORKSPACE_TASK_ATTENTION_LIMIT).toBe(6);
    expect(result).toHaveLength(7);
    expect(result.slice(0, 6).map((row) => row.href)).toEqual(
      records.slice(0, 6).map(workspaceTaskRecoveryHref),
    );
    expect(result[6]?.title).toBe('3 more task changes need attention');
    expect(result[6]?.href).toBe(workspaceTaskRecoveryHref(records[6]!));
    expect(JSON.stringify(state)).toBe(before);
  });
  it('orders stronger reasons before routine gaps and newer observations first within a reason', () => {
    const older = {
      ...confirmed(),
      id: '11111111-1111-4111-8111-111111111111',
      verification: null,
    };
    const newer = {
      ...older,
      id: '33333333-3333-4333-8333-333333333333',
      updatedAt: '2026-10-24T10:00:01.000Z',
    };
    const unfinished = {
      ...confirmed(),
      id: '44444444-4444-4444-8444-444444444444',
      status: 'prepared' as const,
      canRestore: false,
    };
    const state = { ...taskState([older, newer, unfinished]), generatedAt: newer.updatedAt };
    expect(workspaceTaskRows(state, taskWs).map((row) => row.key)).toEqual(
      [unfinished, newer, older].map((record) => `workspace-task:${record.id}`),
    );
  });
});
