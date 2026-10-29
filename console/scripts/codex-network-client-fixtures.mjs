export const context = 'codex-context-' + 'a'.repeat(64),
  workspace = 'workspace-' + 'b'.repeat(24);
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = () => new Date().toISOString();
export const binding = () => ({
  controlContextId: context,
  captureSha256: 'c'.repeat(64),
  configSha256: 'd'.repeat(64),
  runtimeSha256: 'e'.repeat(64),
  nativeBinarySha256: 'f'.repeat(64),
  sourceGraphSha256: '1'.repeat(64),
});
export const capture = (off = false) => ({
  schema: 'stroq-codex-network-capture/1',
  capturedAt: now(),
  binding: binding(),
  compatibility: {
    status: 'supported',
    version: 'codex-cli 0.164.0-alpha.11.1',
    platform: 'darwin',
    binarySha256: 'f'.repeat(64),
  },
  baseline: { kind: 'profile', profile: 'custom', network: off ? 'off' : 'on' },
  actionKind: off ? null : 'profile-network-off',
  filesystemEffect: 'unchanged',
  canGuard: !off,
  canCheck: off,
  reason: off ? 'codex-network-already-off' : null,
  layers: [],
  gaps: [
    'named-profile-unverified',
    'session-overrides-unverified',
    'running-clients-unverified',
    'other-surfaces-unverified',
  ],
});
export const record = (patch = {}) => ({
  id: id(1),
  operationId: id(2),
  revision: '2'.repeat(64),
  controlContextId: context,
  kind: 'profile-network-off',
  createdAt: now(),
  updatedAt: now(),
  operationStatus: 'guarded',
  ownership: 'current',
  standing: 'selected',
  originalSha256: 'd'.repeat(64),
  candidateSha256: '3'.repeat(64),
  canRestore: true,
  retainsInactiveProfile: false,
  sharedUserConfig: true,
  hostEnforcement: false,
  ...patch,
});
export const state = (records = []) => ({
  schema: 'stroq-codex-network-guard/1',
  controlContextId: context,
  generatedAt: now(),
  available: true,
  history: 'ready',
  records,
  error: null,
});
export const preview = (restore = false, kind = 'profile-network-off') => ({
  schema: 'stroq-codex-network-preview/1',
  id: id(2),
  operationId: id(2),
  controlContextId: context,
  operation: restore ? 'restore' : 'guard',
  kind,
  recordId: id(1),
  recordRevision: restore ? '2'.repeat(64) : null,
  createdAt: now(),
  expiresAt: new Date(Date.now() + 120000).toISOString(),
  binding: restore ? null : binding(),
  beforeSha256: restore ? '3'.repeat(64) : 'd'.repeat(64),
  afterSha256: restore ? 'd'.repeat(64) : '3'.repeat(64),
  filesystemEffect: restore
    ? 'prior-settings'
    : kind === 'profile-child' || kind === 'legacy-enable-workspace'
      ? 'workspace-restricted'
      : 'unchanged',
  networkEffect: restore ? 'prior-settings' : 'off',
  retainsInactiveProfile: restore && kind === 'profile-child',
  sharedUserConfig: true,
  retainsConfigurationCopies: true,
  formattingPreserved: true,
  hostEnforcement: false,
});
export const receipt = (operation = 'guard') => ({
  schema: 'stroq-codex-network-receipt/1',
  operationId: id(2),
  controlContextId: context,
  operation,
  checkedAt: now(),
  writeConfirmed: true,
  record: record(operation === 'restore' ? { operationStatus: 'restored', canRestore: false } : {}),
});
export const checkBinding = () => ({
  ...binding(),
  workspaceId: workspace,
  profileCopySha256: '4'.repeat(64),
  suiteSha256: '5'.repeat(64),
  copyKind: 'profile',
});
export const checkPreview = () => ({
  schema: 'stroq-codex-network-check-preview/1',
  id: id(3),
  operationId: id(3),
  jobId: id(4),
  createdAt: now(),
  expiresAt: new Date(Date.now() + 120000).toISOString(),
  binding: checkBinding(),
  scope: 'isolated-permission-copy',
  changesConfiguration: false,
  retainsDerivedResults: true,
  modelCalls: 0,
  providerCalls: 0,
});
export const job = (status = 'running') => ({
  schema: 'stroq-codex-network-check-job/1',
  id: id(4),
  operationId: id(3),
  binding: checkBinding(),
  startedAt: now(),
  finishedAt: status === 'running' ? null : now(),
  status,
  progress: 'native',
  error:
    status === 'failed'
      ? 'codex-network-check-timeout'
      : status === 'cancelled'
        ? 'codex-network-check-cancelled'
        : null,
  result:
    status === 'completed'
      ? {
          scope: 'isolated-permission-copy',
          outcome: 'passed',
          nativeBinarySha256: 'f'.repeat(64),
          profileCopySha256: '4'.repeat(64),
          suiteSha256: '5'.repeat(64),
          nativeExitCode: 0,
          cleanupConfirmed: true,
          checks: ['tcp', 'unix'].map((id) => ({
            id,
            positiveConnections: 1,
            attempted: true,
            effect: 'denied',
            connections: 0,
            errno: 'EPERM',
          })),
          modelCalls: 0,
          providerCalls: 0,
        }
      : null,
});
export const checkState = (jobs = [], owned = true) => ({
  schema: 'stroq-codex-network-checks/2',
  workspaceId: workspace,
  controlContextId: context,
  generatedAt: now(),
  history: 'ready',
  jobs,
  activeJobId: jobs.find((j) => j.status === 'running')?.id ?? null,
  ownedJobId: owned ? (jobs.find((j) => j.status === 'running')?.id ?? null) : null,
  error: null,
});
