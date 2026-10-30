import {
  validateCodexPathGuardPreview,
  validateCodexPathGuardReceipt,
  type CodexPathGuardBinding,
  type CodexPathGuardCapture,
  type CodexPathGuardPreview,
  type CodexPathGuardReceipt,
  type CodexPathGuardRecord,
  type CodexPathGuardSelection,
  type CodexPathGuardRestoreSelection,
  type CodexPathGuardError,
  type CodexPathGuardPresetId,
} from './codex-path-guard';
export const CODEX_PATH_GUARD_LABELS: Record<
  CodexPathGuardPresetId,
  { name: string; path: string }
> = {
  'aws-credentials': { name: 'AWS credentials', path: '~/.aws/credentials' },
  'ssh-ed25519': { name: 'SSH Ed25519 key', path: '~/.ssh/id_ed25519' },
  'ssh-rsa': { name: 'SSH RSA key', path: '~/.ssh/id_rsa' },
  npmrc: { name: 'npm settings', path: '~/.npmrc' },
  netrc: { name: 'Network credentials', path: '~/.netrc' },
  pgpass: { name: 'PostgreSQL passwords', path: '~/.pgpass' },
  'git-credentials': { name: 'Git credentials', path: '~/.git-credentials' },
};
export const CODEX_PATH_GUARD_MESSAGES: Record<CodexPathGuardError, string> = {
  'codex-path-guard-unavailable': 'Codex path settings are unavailable.',
  'codex-path-guard-stale': 'Settings or path metadata changed. Inspect again.',
  'codex-path-guard-unsupported': 'These settings cannot be changed safely here.',
  'codex-path-guard-already-denied': 'This path is already declared denied.',
  'codex-path-guard-target-unsafe': 'This path cannot be selected safely.',
  'codex-path-guard-target-unavailable': 'Path metadata could not be verified.',
  'codex-path-guard-project-override': 'Project settings override this user default.',
  'codex-path-guard-managed-unverified': 'Managed requirements could not be verified.',
  'codex-path-guard-mixed-config': 'Mixed permission formats need manual review.',
  'codex-path-guard-parent-unavailable': 'A permission parent could not be verified.',
  'codex-path-guard-invalid': 'The configuration could not be understood safely.',
  'codex-path-guard-limit': 'The configuration exceeds the supported bounds.',
  'codex-path-guard-conflict': 'The owned path rule changed. Restore cannot overwrite it.',
  'codex-path-guard-store-unavailable': 'Saved changes could not be verified.',
  'codex-path-guard-store-full': 'Saved change storage is full. Recovery data was retained.',
  'codex-path-guard-recovery-required': 'Recheck the unfinished change first.',
  'codex-path-guard-write-unconfirmed': 'Completion is unknown. Recheck this exact change.',
  'codex-path-guard-runtime-changed': 'Stroq changed. Inspect settings again.',
  'codex-path-guard-native-changed': 'The Codex executable changed. Inspect settings again.',
  'codex-path-guard-consent-required': 'Confirm shared scope and retained configuration copies.',
  'codex-path-guard-busy': 'Another local operation is running. Try after it finishes.',
  'codex-path-guard-superseded':
    'A newer change owns this path rule. This record cannot restore it.',
  'codex-path-guard-expired': 'Preview expired. Prepare a new review.',
};
export const pathGuardMessage = (error: unknown, fallback: string) =>
  error instanceof Error && Object.values(CODEX_PATH_GUARD_MESSAGES).includes(error.message)
    ? error.message
    : fallback;
export type PathGuardTransport = (
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export type PathGuardPending = { preview: CodexPathGuardPreview; startedAt: string };
export const PATH_GUARD_PENDING_LIMIT = 8;
const pending = new WeakMap<PathGuardTransport, Map<string, PathGuardPending>>(),
  listeners = new WeakMap<PathGuardTransport, Set<() => void>>();
export const pathGuardPendingKey = (context: string, id: string) => `${context}:${id}`;
export function codexPathGuardPending(transport: PathGuardTransport) {
  let map = pending.get(transport);
  if (!map) {
    map = new Map();
    pending.set(transport, map);
  }
  return map;
}
export function subscribeCodexPathGuardPending(
  transport: PathGuardTransport,
  listener: () => void,
) {
  let set = listeners.get(transport);
  if (!set) {
    set = new Set();
    listeners.set(transport, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
export function notifyCodexPathGuardPending(transport: PathGuardTransport) {
  listeners.get(transport)?.forEach((fn) => fn());
}
export function pathGuardBindingMatches(a: CodexPathGuardBinding, b: CodexPathGuardBinding) {
  return (
    [
      'controlContextId',
      'captureSha256',
      'configSha256',
      'runtimeSha256',
      'nativeBinarySha256',
      'sourceGraphSha256',
      'targetMetadataSha256',
    ] as const
  ).every((k) => a[k] === b[k]);
}
export function pathGuardPreviewMatches(
  value: unknown,
  request: CodexPathGuardSelection | CodexPathGuardRestoreSelection,
  capture: CodexPathGuardCapture | null,
  record?: CodexPathGuardRecord,
): value is CodexPathGuardPreview {
  if (
    !validateCodexPathGuardPreview(value) ||
    value.controlContextId !== request.controlContextId ||
    value.operation !== request.operation ||
    Date.parse(value.expiresAt) <= Date.now()
  )
    return false;
  if (request.operation === 'restore')
    return (
      !!record &&
      value.recordId === request.recordId &&
      value.recordRevision === request.recordRevision &&
      value.presetId === record.presetId &&
      value.kind === record.kind
    );
  return (
    !!capture?.binding &&
    !!value.binding &&
    pathGuardBindingMatches(value.binding, capture.binding) &&
    value.binding.captureSha256 === request.captureSha256 &&
    value.presetId === request.presetId &&
    value.kind === capture.actionKind &&
    value.beforeSha256 === capture.binding.configSha256 &&
    capture.presets.some((p) => p.id === request.presetId && p.canGuard)
  );
}
export function pathGuardReceiptMatches(
  value: unknown,
  p: CodexPathGuardPreview,
  recheck = false,
): value is CodexPathGuardReceipt {
  return (
    validateCodexPathGuardReceipt(value) &&
    value.controlContextId === p.controlContextId &&
    value.operationId === p.operationId &&
    value.record.id === p.recordId &&
    value.record.kind === p.kind &&
    value.record.presetId === p.presetId &&
    value.operation === (recheck ? 'recheck' : p.operation) &&
    value.checkedAt >= p.createdAt &&
    (p.operation !== 'guard' ||
      (value.record.originalSha256 === p.beforeSha256 &&
        value.record.candidateSha256 === p.afterSha256)) &&
    (!value.writeConfirmed ||
      value.record.operationStatus === (p.operation === 'guard' ? 'guarded' : 'restored'))
  );
}
export function confirmPathGuard(transport: PathGuardTransport, receipt: CodexPathGuardReceipt) {
  const map = codexPathGuardPending(transport),
    k = pathGuardPendingKey(receipt.controlContextId, receipt.record.id),
    write = map.get(k);
  if (
    !write ||
    !receipt.writeConfirmed ||
    !pathGuardReceiptMatches(receipt, write.preview, receipt.operation === 'recheck') ||
    receipt.checkedAt < write.startedAt
  )
    return false;
  map.delete(k);
  notifyCodexPathGuardPending(transport);
  return true;
}
