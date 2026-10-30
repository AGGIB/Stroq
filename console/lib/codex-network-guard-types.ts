export const CODEX_NETWORK_GUARD_ERRORS = [
  'codex-network-unavailable',
  'codex-network-stale',
  'codex-network-unsupported',
  'codex-network-already-off',
  'codex-network-project-override',
  'codex-network-managed-unverified',
  'codex-network-mixed-config',
  'codex-network-parent-unavailable',
  'codex-network-conflict',
  'codex-network-store-unavailable',
  'codex-network-store-full',
  'codex-network-recovery-required',
  'codex-network-write-unconfirmed',
  'codex-network-runtime-changed',
  'codex-network-native-changed',
  'codex-network-consent-required',
  'codex-network-busy',
  'codex-network-superseded',
] as const;
export const CODEX_NETWORK_GUARD_GAPS = [
  'named-profile-unverified',
  'session-overrides-unverified',
  'running-clients-unverified',
  'other-surfaces-unverified',
  'system-source-unavailable',
  'managed-source-unverified',
  'project-source-unavailable',
  'context-unavailable',
  'native-unsupported',
] as const;
export type CodexNetworkGuardError = (typeof CODEX_NETWORK_GUARD_ERRORS)[number];
export type CodexNetworkGuardKind =
  'profile-network-off' | 'profile-child' | 'legacy-network-off' | 'legacy-enable-workspace';
export type CodexNetworkGuardBinding = {
  controlContextId: string;
  captureSha256: string;
  configSha256: string | null;
  runtimeSha256: string;
  nativeBinarySha256: string;
  sourceGraphSha256: string;
};
export type CodexNetworkGuardLayer = {
  id: string;
  scope: 'user' | 'system' | 'project' | 'managed';
  status: 'captured' | 'absent' | 'unsupported';
  effect: 'none' | 'parent-edit' | 'selector-override' | 'network-override' | 'mixed' | 'unknown';
};
export interface CodexNetworkGuardCapture {
  schema: 'stroq-codex-network-capture/1';
  capturedAt: string;
  binding: CodexNetworkGuardBinding | null;
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
  actionKind: CodexNetworkGuardKind | null;
  filesystemEffect: 'unchanged' | 'workspace-restricted' | 'unavailable';
  canGuard: boolean;
  canCheck: boolean;
  reason: CodexNetworkGuardError | null;
  layers: CodexNetworkGuardLayer[];
  gaps: (typeof CODEX_NETWORK_GUARD_GAPS)[number][];
}
export interface CodexNetworkGuardSelection {
  operation: 'guard';
  controlContextId: string;
  captureSha256: string;
}
export interface CodexNetworkGuardRestoreSelection {
  operation: 'restore';
  controlContextId: string;
  recordId: string;
  recordRevision: string;
}
export interface CodexNetworkGuardRecheckSelection {
  controlContextId: string;
  recordId: string;
  recordRevision: string;
  operationId: string;
}
export interface CodexNetworkGuardPreview {
  schema: 'stroq-codex-network-preview/1';
  id: string;
  operationId: string;
  controlContextId: string;
  operation: 'guard' | 'restore';
  kind: CodexNetworkGuardKind;
  recordId: string;
  recordRevision: string | null;
  createdAt: string;
  expiresAt: string;
  binding: CodexNetworkGuardBinding | null;
  beforeSha256: string | null;
  afterSha256: string | null;
  filesystemEffect: 'unchanged' | 'workspace-restricted' | 'prior-settings';
  networkEffect: 'off' | 'prior-settings';
  retainsInactiveProfile: boolean;
  sharedUserConfig: true;
  retainsConfigurationCopies: true;
  formattingPreserved: true;
  hostEnforcement: false;
}
export interface CodexNetworkGuardRecord {
  id: string;
  operationId: string;
  revision: string;
  controlContextId: string;
  kind: CodexNetworkGuardKind;
  createdAt: string;
  updatedAt: string;
  operationStatus: 'unknown' | 'guarded' | 'restored';
  ownership: 'current' | 'superseded';
  standing: 'selected' | 'changed' | 'overridden' | 'unavailable';
  originalSha256: string | null;
  candidateSha256: string;
  canRestore: boolean;
  retainsInactiveProfile: boolean;
  sharedUserConfig: true;
  hostEnforcement: false;
}
export interface CodexNetworkGuardState {
  schema: 'stroq-codex-network-guard/1';
  controlContextId: string | null;
  generatedAt: string;
  available: boolean;
  history: 'ready' | 'missing' | 'unavailable';
  records: CodexNetworkGuardRecord[];
  error: CodexNetworkGuardError | null;
}
export interface CodexNetworkGuardReceipt {
  schema: 'stroq-codex-network-receipt/1';
  operationId: string;
  controlContextId: string;
  operation: 'guard' | 'restore' | 'recheck';
  checkedAt: string;
  writeConfirmed: boolean;
  record: CodexNetworkGuardRecord;
}
