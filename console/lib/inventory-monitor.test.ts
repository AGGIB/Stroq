import { describe, expect, it } from 'vitest';
import {
  validateInventoryMonitorState,
  validateInventoryMonitorPreview,
  validateInventoryMonitorReceipt,
  validateInventoryObservationRecord,
} from './inventory-monitor';

const sha = 'a'.repeat(64);
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const time = '2026-10-24T00:00:00.000Z';
const workspaceId = 'workspace-' + 'b'.repeat(24);
const record = () => ({
  id,
  firstObservedAt: time,
  lastObservedAt: time,
  runtimeSha256: sha,
  observationSha256: sha,
  itemCount: 1,
  complete: true,
  gaps: 0,
  changes: { status: 'first', fromId: null, total: 0, rows: [], omitted: 0 },
});
const state = () => ({
  schema: 'stroq-inventory-monitor/1',
  workspaceId,
  status: 'disabled',
  reason: null,
  revision: null,
  configuredAt: null,
  runtimeSha256: sha,
  intervalMs: 300000,
  nextCheckAt: null,
  lastAttempt: null,
  latestCheckId: null,
  latestCaptureId: null,
  history: { status: 'missing', revision: null, records: [], omitted: 0 },
});
const preview = () => ({
  schema: 'stroq-inventory-monitor-preview/1',
  id,
  createdAt: time,
  expiresAt: '2026-10-24T00:02:00.000Z',
  workspaceId,
  action: 'enable',
  expectedRevision: null,
  runtimeSha256: sha,
  intervalMs: 300000,
  hostEnforcement: false,
});
describe('separate static inventory watch contracts', () => {
  it('accepts disabled intent and bounded historical versions without implying current review', () => {
    expect(validateInventoryMonitorState(state())).toBe(true);
    expect(validateInventoryObservationRecord(record())).toBe(true);
    expect(
      validateInventoryMonitorState({
        ...state(),
        latestCheckId: id,
        latestCaptureId: id,
        history: { status: 'ready', revision: sha, records: [record()], omitted: 0 },
      }),
    ).toBe(true);
  });
  it('refuses extra fields, mismatched history, duplicate observations and fake current approval', () => {
    for (const value of [
      { ...state(), path: '/private/source' },
      { ...state(), latestCheckId: id },
      { ...state(), latestCheckId: id, latestCaptureId: id },
      { ...state(), status: 'enabled' },
      { ...state(), nextCheckAt: time },
      {
        ...state(),
        history: { status: 'ready', revision: sha, records: [record(), record()], omitted: 0 },
      },
    ])
      expect(validateInventoryMonitorState(value)).toBe(false);
    expect(validateInventoryObservationRecord({ ...record(), reviewed: true })).toBe(false);
  });
  it('distinguishes attempted checks from accepted captures and refuses invented successful evidence', () => {
    const running = {
      status: 'running',
      startedAt: time,
      finishedAt: null,
      error: null,
      checkId: id,
      captureId: null,
    };
    expect(validateInventoryMonitorState({ ...state(), lastAttempt: running })).toBe(true);
    expect(
      validateInventoryMonitorState({
        ...state(),
        lastAttempt: { ...running, status: 'completed', finishedAt: time },
      }),
    ).toBe(false);
    expect(
      validateInventoryMonitorState({
        ...state(),
        lastAttempt: {
          ...running,
          status: 'failed',
          finishedAt: time,
          error: 'inventory-unavailable',
        },
      }),
    ).toBe(true);
    expect(
      validateInventoryMonitorState({
        ...state(),
        lastAttempt: { ...running, error: 'PRIVATE_RAW_ERROR' },
      }),
    ).toBe(false);
  });
  it('requires exact source identity and finite before/after evidence for historical change links', () => {
    const artifact = {
      id: 'item-' + 'a'.repeat(24),
      kind: 'skill',
      name: 'notes',
      agent: 'shared',
      scope: 'user',
      skillSource: 'agents-skills',
      location: { label: 'group/notes', redacted: false },
    };
    const changed = {
      ...record(),
      changes: {
        status: 'comparable',
        fromId: id,
        total: 1,
        omitted: 0,
        rows: [{ kind: 'changed', artifact, beforeSha256: sha, afterSha256: 'b'.repeat(64) }],
      },
    };
    expect(validateInventoryObservationRecord(changed)).toBe(true);
    expect(
      validateInventoryObservationRecord({
        ...changed,
        changes: { ...changed.changes, omitted: 1 },
      }),
    ).toBe(false);
    expect(
      validateInventoryObservationRecord({
        ...changed,
        changes: {
          ...changed.changes,
          rows: [{ ...changed.changes.rows[0], artifact: { ...artifact, agent: 'cursor' } }],
        },
      }),
    ).toBe(false);
    expect(
      validateInventoryObservationRecord({
        ...changed,
        changes: { ...changed.changes, rows: [{ ...changed.changes.rows[0], beforeSha256: null }] },
      }),
    ).toBe(false);
  });
  it('binds preview and receipt to finite action, lifetime, scope and no host-enforcement claim', () => {
    expect(validateInventoryMonitorPreview(preview())).toBe(true);
    expect(
      validateInventoryMonitorPreview({ ...preview(), expiresAt: '2026-10-24T00:02:00.001Z' }),
    ).toBe(false);
    expect(validateInventoryMonitorPreview({ ...preview(), hostEnforcement: true })).toBe(false);
    const receipt = {
      schema: 'stroq-inventory-monitor-receipt/1',
      previewId: id,
      workspaceId,
      action: 'enable',
      completedAt: time,
      revision: sha,
      runtimeSha256: sha,
      enabled: true,
      hostEnforcement: false,
    };
    expect(validateInventoryMonitorReceipt(receipt)).toBe(true);
    expect(validateInventoryMonitorReceipt({ ...receipt, enabled: false })).toBe(false);
    expect(validateInventoryMonitorReceipt({ ...receipt, path: '/tmp/anywhere' })).toBe(false);
  });
});
