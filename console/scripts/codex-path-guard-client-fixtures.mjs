/** A two-minute window from one reading of the clock: two readings are now and then a millisecond apart. */
const twoMinutes = () => {
  const at = Date.now();
  return { createdAt: new Date(at).toISOString(), expiresAt: new Date(at + 120000).toISOString() };
};
export const context = 'codex-context-' + 'a'.repeat(64),
  workspace = 'workspace-' + 'b'.repeat(24);
export const presets = [
  'aws-credentials',
  'ssh-ed25519',
  'ssh-rsa',
  'npmrc',
  'netrc',
  'pgpass',
  'git-credentials',
];
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = () => new Date().toISOString();
export const binding = () => ({
  controlContextId: context,
  captureSha256: 'c'.repeat(64),
  configSha256: 'd'.repeat(64),
  runtimeSha256: 'e'.repeat(64),
  nativeBinarySha256: 'f'.repeat(64),
  sourceGraphSha256: '1'.repeat(64),
  targetMetadataSha256: '9'.repeat(64),
});
export const capture = () => ({
  schema: 'stroq-codex-path-capture/1',
  capturedAt: now(),
  binding: binding(),
  compatibility: {
    status: 'supported',
    version: 'codex-cli 0.164.0-alpha.11.1',
    platform: 'darwin',
    binarySha256: 'f'.repeat(64),
  },
  baseline: { kind: 'profile', profile: 'custom', network: 'off' },
  actionKind: 'profile-path-deny',
  reason: null,
  presets: presets.map((id) => ({
    id,
    target: 'regular',
    declaration: 'read',
    canGuard: true,
    reason: null,
  })),
  gaps: [
    'running-clients-unverified',
    'path-aliases-uncovered',
    'existing-data-unrevoked',
    'file-tools-unverified',
  ],
});
export const record = (patch = {}) => ({
  id: id(1),
  operationId: id(2),
  revision: '2'.repeat(64),
  controlContextId: context,
  kind: 'profile-path-deny',
  presetId: 'aws-credentials',
  createdAt: now(),
  updatedAt: now(),
  operationStatus: 'guarded',
  ownership: 'current',
  standing: 'selected',
  originalSha256: 'd'.repeat(64),
  candidateSha256: '3'.repeat(64),
  canRestore: true,
  sharedUserConfig: true,
  hostEnforcement: false,
  ...patch,
});
export const state = (records = []) => ({
  schema: 'stroq-codex-path-guard/1',
  controlContextId: context,
  generatedAt: now(),
  available: true,
  history: 'ready',
  records,
  error: null,
});
export const preview = (restore = false, presetId = 'aws-credentials') => ({
  schema: 'stroq-codex-path-preview/1',
  id: id(8),
  operationId: id(2),
  controlContextId: context,
  operation: restore ? 'restore' : 'guard',
  kind: 'profile-path-deny',
  presetId,
  recordId: id(1),
  recordRevision: restore ? '2'.repeat(64) : null,
  ...twoMinutes(),
  binding: restore ? null : binding(),
  beforeSha256: restore ? '3'.repeat(64) : 'd'.repeat(64),
  afterSha256: restore ? 'd'.repeat(64) : '3'.repeat(64),
  pathEffect: restore ? 'prior-settings' : 'deny-read-write',
  filesystemEffect: restore ? 'prior-settings' : 'deny-exact-path',
  networkEffect: 'preserved',
  sharedUserConfig: true,
  retainsConfigurationCopies: true,
  formattingPreserved: true,
  hostEnforcement: false,
});
export const receipt = (operation = 'guard') => ({
  schema: 'stroq-codex-path-receipt/1',
  operationId: id(2),
  controlContextId: context,
  operation,
  checkedAt: now(),
  writeConfirmed: true,
  record: record(operation === 'restore' ? { operationStatus: 'restored', canRestore: false } : {}),
});
