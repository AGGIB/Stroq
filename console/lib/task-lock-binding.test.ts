import { describe, expect, it } from 'vitest';
import type { TaskLockPreview, TaskLockReceipt, TaskLockRow } from './task-locks';
import {
  taskLockKey,
  taskLockPreviewMatches,
  taskLockApplyInput,
  taskLockReceiptMatches,
} from './task-lock-binding';
const ws = `workspace-${'a'.repeat(24)}`;
const row = {
  id: `task-${'b'.repeat(64)}`,
  permitSha256: 'c'.repeat(64),
  profile: 'repo-edit-and-test',
  policySha256: 'd'.repeat(64),
  issuedAt: '2026-10-23T00:00:00.000Z',
  expiresAt: '2026-10-23T01:00:00.000Z',
  declaredMode: 'srt',
  eligibility: 'eligible',
  standing: 'present',
  policyRelation: 'matches-current',
  scope: {
    tools: ['Read', 'Write'],
    shell: 'denied',
    read: { allow: [], deny: [] },
    write: { allow: [], deny: [] },
    net: { mode: 'none' },
    mcp: [],
  },
  evidence: { status: 'missing', journalSha256: null, counts: null, lastGate: null },
} satisfies TaskLockRow;
const preview = {
  schema: 'stroq-task-lock-preview/1',
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: ws,
  createdAt: '2026-10-23T00:00:01.000Z',
  expiresAt: '2026-10-23T00:02:01.000Z',
  task: row,
  bindingSha256: 'e'.repeat(64),
  canApply: true,
  reason: null,
} satisfies TaskLockPreview;
const receipt = {
  schema: 'stroq-task-lock-receipt/1',
  id: '22222222-2222-4222-8222-222222222222',
  previewId: preview.id,
  workspaceId: ws,
  taskId: row.id,
  permitSha256: row.permitSha256,
  status: 'revoked',
  checkedAt: '2026-10-23T00:00:02.000Z',
  markerSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  storeReadback: 'revoked',
  gateDecision: 'deny',
  gateRule: 'task-void:revoked',
  evidence: 'isolated-gate-evaluation',
  hostTermination: 'unverified',
  irreversible: true,
} satisfies TaskLockReceipt;
describe('exact task permission revocation binding', () => {
  it('fences task, permit revision, workspace and request generation', () => {
    const key = taskLockKey(ws, row, 0);
    expect(key).toBeTruthy();
    expect(taskLockKey(ws, { ...row, permitSha256: 'f'.repeat(64) }, 0)).not.toBe(key);
    expect(taskLockKey(ws, row, 1)).not.toBe(key);
    expect(taskLockKey(null, row, 0)).toBeNull();
  });
  it('accepts only the exact immutable signed grants while allowing fresh standing/evidence', () => {
    expect(taskLockPreviewMatches(preview, row, ws)).toBe(true);
    expect(
      taskLockPreviewMatches({ ...preview, workspaceId: `workspace-${'f'.repeat(24)}` }, row, ws),
    ).toBe(false);
    expect(
      taskLockPreviewMatches(
        { ...preview, task: { ...row, permitSha256: 'f'.repeat(64) } },
        row,
        ws,
      ),
    ).toBe(false);
    expect(
      taskLockPreviewMatches(
        { ...preview, task: { ...row, scope: { ...row.scope, shell: 'allowed' } } },
        row,
        ws,
      ),
    ).toBe(false);
    expect(
      taskLockPreviewMatches({ ...preview, task: { ...row, declaredMode: 'hook-only' } }, row, ws),
    ).toBe(false);
    expect(
      taskLockPreviewMatches(
        { ...preview, task: { ...row, standing: 'ended' }, canApply: false, reason: 'task-ended' },
        row,
        ws,
      ),
    ).toBe(true);
  });
  it('requires current preview and explicit task-interruption consent and sends no grants', () => {
    const now = Date.parse(preview.createdAt) + 1;
    expect(taskLockApplyInput(preview, false, now)).toBeNull();
    expect(taskLockApplyInput(preview, true, now)).toEqual({
      previewId: preview.id,
      acknowledgeTaskInterruption: true,
    });
    expect(taskLockApplyInput(preview, true, Date.parse(preview.expiresAt))).toBeNull();
    expect(taskLockApplyInput({ ...preview, canApply: false }, true, now)).toBeNull();
  });
  it('accepts only this preview and permit receipt, never agent-termination claims', () => {
    expect(taskLockReceiptMatches(receipt, preview)).toBe(true);
    expect(taskLockReceiptMatches({ ...receipt, previewId: receipt.id }, preview)).toBe(false);
    expect(taskLockReceiptMatches({ ...receipt, taskId: `task-${'f'.repeat(64)}` }, preview)).toBe(
      false,
    );
    expect(taskLockReceiptMatches({ ...receipt, permitSha256: 'f'.repeat(64) }, preview)).toBe(
      false,
    );
    expect(
      taskLockReceiptMatches({ ...receipt, checkedAt: '2026-10-22T00:00:00.000Z' }, preview),
    ).toBe(false);
  });
});
