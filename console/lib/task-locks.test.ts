import { describe, expect, it } from 'vitest';
import {
  TASK_LOCK_LIMITATIONS,
  validateTaskLockRow,
  validateTaskLockState,
  validateTaskLockPreview,
  validateTaskLockReceipt,
} from './task-locks';
const sha = 'a'.repeat(64),
  workspaceId = `workspace-${'b'.repeat(24)}`,
  at = '2026-10-23T00:00:00.000Z';
const task = () => ({
  id: `task-${sha}`,
  permitSha256: sha,
  profile: 'code',
  policySha256: sha,
  issuedAt: at,
  expiresAt: '2026-10-23T01:00:00.000Z',
  declaredMode: 'hook-only',
  eligibility: 'eligible',
  standing: 'present',
  policyRelation: 'matches-current',
  scope: {
    tools: ['Bash'],
    shell: 'allowed',
    read: { allow: [{ id: sha, root: 'workspace', pattern: '**' }], deny: [] },
    write: { allow: [], deny: [] },
    net: { mode: 'none' },
    mcp: [],
  },
  evidence: { status: 'missing', journalSha256: null, counts: null, lastGate: null },
});
const state = () => ({
  schema: 'stroq-task-locks/1',
  workspaceId,
  host: 'claude-code',
  checkedAt: at,
  currentPolicySha256: sha,
  available: true,
  reason: null,
  coverage: { complete: true, limited: false, unverified: 0, foreign: 0 },
  tasks: [task()],
  limitations: TASK_LOCK_LIMITATIONS,
});
describe('task permission boundary', () => {
  it('accepts bounded recorded permissions without liveness claims', () => {
    expect(validateTaskLockState(state())).toBe(true);
    expect(validateTaskLockState({ ...state(), running: true })).toBe(false);
  });
  it('withholds external paths and rejects raw signing data', () => {
    const row = task();
    row.scope.read.allow[0] = { id: sha, root: 'external', pattern: '/private/secret' };
    expect(validateTaskLockRow(row)).toBe(false);
    expect(validateTaskLockRow({ ...task(), nonce: 'private' })).toBe(false);
  });
  it('distinguishes missing evidence from verified zero events', () => {
    const value = {
      ...state(),
      tasks: [
        {
          ...task(),
          evidence: {
            status: 'verified',
            journalSha256: sha,
            counts: null,
            lastGate: null,
          },
        },
      ],
    };
    expect(validateTaskLockState(value)).toBe(false);
  });
  it('derives incomplete coverage and policy drift instead of accepting green contradictions', () => {
    expect(
      validateTaskLockState({
        ...state(),
        coverage: { complete: true, limited: true, unverified: 0, foreign: 0 },
      }),
    ).toBe(false);
    expect(validateTaskLockState({ ...state(), currentPolicySha256: 'c'.repeat(64) })).toBe(false);
  });
  it('validates permit eligibility at actual capture time with core clock skew', () => {
    expect(validateTaskLockState({ ...state(), checkedAt: '2026-10-24T00:00:00.000Z' })).toBe(
      false,
    );
    const value = state();
    value.tasks[0]!.eligibility = 'expired';
    value.checkedAt = '2026-10-24T00:00:00.000Z';
    expect(validateTaskLockState(value)).toBe(true);
  });
  it('keeps future-issued permits separate and preserves the actual core clock-skew boundary', () => {
    const value = state();
    value.checkedAt = '2026-10-22T23:58:59.999Z';
    expect(validateTaskLockState(value)).toBe(false);
    value.tasks[0]!.eligibility = 'not-yet-valid';
    expect(validateTaskLockState(value)).toBe(true);
    value.checkedAt = '2026-10-22T23:59:00.000Z';
    expect(validateTaskLockState(value)).toBe(false);
    value.tasks[0]!.eligibility = 'eligible';
    expect(validateTaskLockState(value)).toBe(true);
  });
  it('binds preview readiness to exact standing and expiry', () => {
    const value = {
      schema: 'stroq-task-lock-preview/1',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId,
      createdAt: at,
      expiresAt: '2026-10-23T00:02:00.000Z',
      task: task(),
      bindingSha256: sha,
      canApply: true,
      reason: null,
    };
    expect(validateTaskLockPreview(value)).toBe(true);
    expect(validateTaskLockPreview({ ...value, task: { ...task(), standing: 'revoked' } })).toBe(
      false,
    );
  });
  it('requires exact isolated gate evidence and keeps termination unverified', () => {
    const value = {
      schema: 'stroq-task-lock-receipt/1',
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      workspaceId,
      taskId: `task-${sha}`,
      permitSha256: sha,
      status: 'revoked',
      checkedAt: at,
      markerSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      storeReadback: 'revoked',
      gateDecision: 'deny',
      gateRule: 'task-void:revoked',
      evidence: 'isolated-gate-evaluation',
      hostTermination: 'unverified',
      irreversible: true,
    };
    expect(validateTaskLockReceipt(value)).toBe(true);
    expect(validateTaskLockReceipt({ ...value, hostTermination: 'stopped' })).toBe(false);
  });
});
