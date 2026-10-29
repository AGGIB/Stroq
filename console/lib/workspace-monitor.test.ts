import { describe, expect, it } from 'vitest';
import {
  validateWorkspaceMonitorState,
  validateWorkspaceMonitorPreview,
  validateWorkspaceMonitorReceipt,
} from './workspace-monitor';

const at = '2026-10-24T00:00:00.000Z';
const sha = 'a'.repeat(64);
const id = '12345678-1234-4234-8234-123456789abc';
const state = {
  schema: 'stroq-workspace-monitor/1',
  workspaceId: 'workspace-1234567890abcdef12345678',
  status: 'disabled',
  reason: null,
  revision: null,
  configuredAt: null,
  runtimeSha256: sha,
  intervalMs: 300000,
  nextCheckAt: null,
  activeRunId: null,
  lastAttempt: null,
};
const preview = {
  schema: 'stroq-workspace-monitor-preview/1',
  workspaceId: state.workspaceId,
  id,
  createdAt: at,
  expiresAt: '2026-10-24T00:02:00.000Z',
  action: 'enable',
  expectedRevision: null,
  runtimeSha256: sha,
  intervalMs: 300000,
  hostEnforcement: false,
};
const receipt = {
  schema: 'stroq-workspace-monitor-receipt/1',
  workspaceId: state.workspaceId,
  previewId: id,
  action: 'enable',
  completedAt: at,
  revision: sha,
  runtimeSha256: sha,
  enabled: true,
  hostEnforcement: false,
};
describe('workspace monitor boundary', () => {
  it('accepts fixed local-only state, preview and acknowledgement', () => {
    expect(validateWorkspaceMonitorState(state)).toBe(true);
    expect(validateWorkspaceMonitorPreview(preview)).toBe(true);
    expect(validateWorkspaceMonitorReceipt(receipt)).toBe(true);
  });
  it('rejects unknown keys, arbitrary intervals and enforcement claims', () => {
    for (const value of [
      { ...state, extra: true },
      { ...state, intervalMs: 10 },
      { ...state, reason: 'anything' },
    ])
      expect(validateWorkspaceMonitorState(value)).toBe(false);
    expect(validateWorkspaceMonitorPreview({ ...preview, hostEnforcement: true })).toBe(false);
    expect(validateWorkspaceMonitorReceipt({ ...receipt, enabled: false })).toBe(false);
  });
  it('rejects fabricated running or scheduled status', () => {
    expect(validateWorkspaceMonitorState({ ...state, status: 'enabled' })).toBe(false);
    expect(validateWorkspaceMonitorState({ ...state, nextCheckAt: at })).toBe(false);
    expect(validateWorkspaceMonitorState({ ...state, activeRunId: id })).toBe(false);
  });
  it('validates terminal attempts and exact active run identity', () => {
    const lastAttempt = {
      status: 'completed',
      startedAt: at,
      finishedAt: at,
      runId: id,
      error: null,
    };
    expect(validateWorkspaceMonitorState({ ...state, lastAttempt })).toBe(true);
    expect(
      validateWorkspaceMonitorState({
        ...state,
        lastAttempt: { ...lastAttempt, finishedAt: null },
      }),
    ).toBe(false);
    expect(
      validateWorkspaceMonitorState({
        ...state,
        status: 'enabled',
        revision: sha,
        configuredAt: at,
        activeRunId: id,
        lastAttempt: { ...lastAttempt, status: 'running', finishedAt: null },
      }),
    ).toBe(true);
  });
  it('rejects expired-order or oversized preview lifetimes and malformed identities', () => {
    expect(validateWorkspaceMonitorPreview({ ...preview, expiresAt: at })).toBe(false);
    expect(
      validateWorkspaceMonitorPreview({ ...preview, expiresAt: '2026-10-24T00:03:00.000Z' }),
    ).toBe(false);
    expect(validateWorkspaceMonitorReceipt({ ...receipt, previewId: 'x' })).toBe(false);
  });
});
