export const CODEX_PATH_GUARD_PRESETS = [
  'aws-credentials',
  'ssh-ed25519',
  'ssh-rsa',
  'npmrc',
  'netrc',
  'pgpass',
  'git-credentials',
] as const;
export type CodexPathGuardPresetId = (typeof CODEX_PATH_GUARD_PRESETS)[number];
export const CODEX_PATH_GUARD_ERRORS = [
  'codex-path-guard-unavailable',
  'codex-path-guard-stale',
  'codex-path-guard-unsupported',
  'codex-path-guard-already-denied',
  'codex-path-guard-target-unsafe',
  'codex-path-guard-target-unavailable',
  'codex-path-guard-project-override',
  'codex-path-guard-managed-unverified',
  'codex-path-guard-mixed-config',
  'codex-path-guard-parent-unavailable',
  'codex-path-guard-invalid',
  'codex-path-guard-limit',
  'codex-path-guard-conflict',
  'codex-path-guard-store-unavailable',
  'codex-path-guard-store-full',
  'codex-path-guard-recovery-required',
  'codex-path-guard-write-unconfirmed',
  'codex-path-guard-runtime-changed',
  'codex-path-guard-native-changed',
  'codex-path-guard-consent-required',
  'codex-path-guard-busy',
  'codex-path-guard-superseded',
  'codex-path-guard-expired',
] as const;
export const CODEX_PATH_GUARD_GAPS = [
  'named-profile-unverified',
  'session-overrides-unverified',
  'running-clients-unverified',
  'other-surfaces-unverified',
  'system-source-unavailable',
  'managed-source-unverified',
  'project-source-unavailable',
  'context-unavailable',
  'native-unsupported',
  'path-aliases-uncovered',
  'existing-data-unrevoked',
  'file-tools-unverified',
] as const;
export type CodexPathGuardError = (typeof CODEX_PATH_GUARD_ERRORS)[number];
export type CodexPathGuardKind = 'profile-path-deny';
export type CodexPathGuardBinding = {
  controlContextId: string;
  captureSha256: string;
  configSha256: string | null;
  runtimeSha256: string;
  nativeBinarySha256: string;
  sourceGraphSha256: string;
  targetMetadataSha256: string;
};
export type CodexPathGuardPreset = {
  id: CodexPathGuardPresetId;
  target: 'regular' | 'absent' | 'unsafe' | 'unavailable';
  declaration: 'deny' | 'read' | 'write' | 'unknown';
  canGuard: boolean;
  reason: CodexPathGuardError | null;
};
export interface CodexPathGuardCapture {
  schema: 'stroq-codex-path-capture/1';
  capturedAt: string;
  binding: CodexPathGuardBinding | null;
  compatibility: {
    status: 'supported' | 'unsupported' | 'unavailable';
    version: string | null;
    platform: 'darwin' | 'unsupported';
    binarySha256: string | null;
  };
  baseline: {
    kind: 'implicit' | 'profile' | 'legacy' | 'unavailable';
    profile: 'workspace' | 'read-only' | 'full-access' | 'custom' | 'none';
    network: 'on' | 'off' | 'unknown';
  };
  actionKind: CodexPathGuardKind | null;
  reason: CodexPathGuardError | null;
  presets: CodexPathGuardPreset[];
  gaps: (typeof CODEX_PATH_GUARD_GAPS)[number][];
}
export interface CodexPathGuardSelection {
  operation: 'guard';
  controlContextId: string;
  captureSha256: string;
  presetId: CodexPathGuardPresetId;
}
export interface CodexPathGuardRestoreSelection {
  operation: 'restore';
  controlContextId: string;
  recordId: string;
  recordRevision: string;
}
export interface CodexPathGuardRecheckSelection {
  controlContextId: string;
  recordId: string;
  recordRevision: string;
  operationId: string;
}
export interface CodexPathGuardPreview {
  schema: 'stroq-codex-path-preview/1';
  id: string;
  operationId: string;
  controlContextId: string;
  operation: 'guard' | 'restore';
  kind: CodexPathGuardKind;
  presetId: CodexPathGuardPresetId;
  recordId: string;
  recordRevision: string | null;
  createdAt: string;
  expiresAt: string;
  binding: CodexPathGuardBinding | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  pathEffect: 'deny-read-write' | 'prior-settings';
  filesystemEffect: 'deny-exact-path' | 'prior-settings';
  networkEffect: 'preserved';
  sharedUserConfig: true;
  retainsConfigurationCopies: true;
  formattingPreserved: true;
  hostEnforcement: false;
}
export interface CodexPathGuardRecord {
  id: string;
  operationId: string;
  revision: string;
  controlContextId: string;
  kind: CodexPathGuardKind;
  presetId: CodexPathGuardPresetId;
  createdAt: string;
  updatedAt: string;
  operationStatus: 'unknown' | 'guarded' | 'restored';
  ownership: 'current' | 'superseded';
  standing: 'selected' | 'changed' | 'overridden' | 'unavailable';
  originalSha256: string | null;
  candidateSha256: string;
  canRestore: boolean;
  sharedUserConfig: true;
  hostEnforcement: false;
}
export interface CodexPathGuardState {
  schema: 'stroq-codex-path-guard/1';
  controlContextId: string | null;
  generatedAt: string;
  available: boolean;
  history: 'ready' | 'missing' | 'unavailable';
  records: CodexPathGuardRecord[];
  error: CodexPathGuardError | null;
}
export interface CodexPathGuardReceipt {
  schema: 'stroq-codex-path-receipt/1';
  operationId: string;
  controlContextId: string;
  operation: 'guard' | 'restore' | 'recheck';
  checkedAt: string;
  writeConfirmed: boolean;
  record: CodexPathGuardRecord;
}
