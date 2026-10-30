import { workspace, runtime, revision, uuid } from './inventory-monitor-client-harness.mjs';
export const observedArtifact = {
  id: 'item-' + '1'.repeat(24),
  kind: 'skill',
  name: 'Release notes',
  agent: 'shared',
  skillSource: 'agents-skills',
  location: { label: 'release/notes', redacted: false },
  scope: 'user',
};
export function observation(changes = {}) {
  return {
    id: uuid(500),
    firstObservedAt: '2026-10-24T00:00:00.000Z',
    lastObservedAt: '2026-10-24T00:00:00.000Z',
    runtimeSha256: runtime,
    observationSha256: 'e'.repeat(64),
    itemCount: 1,
    complete: true,
    gaps: 0,
    changes: { status: 'first', fromId: null, total: 0, rows: [], omitted: 0 },
    ...changes,
  };
}
export const inventoryMonitorFixtures = {
  state: () => ({
    schema: 'stroq-inventory-monitor/1',
    workspaceId: workspace,
    status: 'disabled',
    reason: null,
    revision,
    runtimeSha256: runtime,
    configuredAt: '2026-10-24T00:00:00.000Z',
    intervalMs: 300000,
    nextCheckAt: null,
    lastAttempt: null,
    latestCheckId: null,
    latestCaptureId: null,
    history: { status: 'missing', revision: null, records: [], omitted: 0 },
  }),
  preview: (body, serial, now) => ({
    schema: 'stroq-inventory-monitor-preview/1',
    id: uuid(serial),
    workspaceId: workspace,
    action: body.action,
    expectedRevision: body.expectedRevision,
    runtimeSha256: runtime,
    intervalMs: 300000,
    hostEnforcement: false,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
  }),
  receipt: (body, now) => ({
    schema: 'stroq-inventory-monitor-receipt/1',
    previewId: body.previewId,
    workspaceId: workspace,
    action: 'enable',
    revision: 'e'.repeat(64),
    runtimeSha256: runtime,
    enabled: true,
    hostEnforcement: false,
    completedAt: new Date(now).toISOString(),
  }),
};
export function observedState(changes = {}) {
  const record = observation();
  return {
    ...inventoryMonitorFixtures.state(),
    status: 'enabled',
    latestCheckId: uuid(501),
    latestCaptureId: record.id,
    history: { status: 'ready', revision: 'f'.repeat(64), records: [record], omitted: 0 },
    ...changes,
  };
}
