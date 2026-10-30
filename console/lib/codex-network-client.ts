import {
  validateCodexNetworkGuardPreview,
  validateCodexNetworkGuardReceipt,
  type CodexNetworkGuardBinding,
  type CodexNetworkGuardCapture,
  type CodexNetworkGuardPreview,
  type CodexNetworkGuardReceipt,
  type CodexNetworkGuardSelection,
  type CodexNetworkGuardRestoreSelection,
} from './codex-network-guard';
import {
  validateCodexNetworkCheckPreview,
  validateCodexNetworkCheckJob,
  type CodexNetworkCheckBinding,
  type CodexNetworkCheckPreview,
  type CodexNetworkCheckJob,
  type CodexNetworkCheckState,
} from './codex-network-check';
export type NetworkTransport = (
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export const CODEX_NETWORK_ERROR_MESSAGES: Record<string, string> = {
  'codex-network-unavailable': 'Codex user network settings are unavailable.',
  'codex-network-stale': 'Settings changed. Inspect again before a new preview.',
  'codex-network-unsupported': 'These settings cannot be changed safely here.',
  'codex-network-already-off': 'Network is already off in the captured user default.',
  'codex-network-project-override': 'A project setting overrides this user default.',
  'codex-network-managed-unverified': 'Managed requirements could not be verified.',
  'codex-network-mixed-config': 'Mixed permission formats need manual review.',
  'codex-network-parent-unavailable': 'A permission parent could not be verified.',
  'codex-network-conflict': 'The owned setting changed. Restore cannot overwrite it.',
  'codex-network-store-unavailable': 'Saved changes could not be verified.',
  'codex-network-store-full': 'Saved change storage is full. Existing recovery data was retained.',
  'codex-network-recovery-required': 'Recheck the unfinished Codex change first.',
  'codex-network-write-unconfirmed': 'Completion is unknown. Recheck this exact change.',
  'codex-network-runtime-changed': 'Stroq changed. Inspect settings again.',
  'codex-network-native-changed': 'The Codex executable changed. Inspect settings again.',
  'codex-network-consent-required': 'Confirm shared scope and retained copies.',
  'codex-network-busy': 'Another local operation is running. Try again after it finishes.',
  'codex-network-superseded': 'A newer change owns this setting. This record cannot be restored.',
  'codex-network-check-unavailable': 'The native network check is unavailable.',
  'codex-network-check-unsupported': 'This Codex build or platform is unsupported for this check.',
  'codex-network-check-stale': 'The captured settings or native binary changed. Inspect again.',
  'codex-network-check-expired': 'Check preview expired. Prepare another preview.',
  'codex-network-check-busy': 'A native check is already running.',
  'codex-network-check-history-unavailable': 'Check history could not be verified.',
  'codex-network-check-cancelled': 'The check was cancelled.',
  'codex-network-check-timeout': 'The check exceeded its deadline. No pass was recorded.',
  'codex-network-check-invalid-report': 'The check evidence could not be verified.',
  'codex-network-check-cleanup-failed': 'Test cleanup was not confirmed. No pass was accepted.',
  'codex-network-check-output-limit': 'The check exceeded its output bound.',
  'codex-network-check-server-stopped': 'The server stopped before the check finished.',
};
export const networkMessage = (error: unknown, fallback: string) =>
  error instanceof Error && Object.values(CODEX_NETWORK_ERROR_MESSAGES).includes(error.message)
    ? error.message
    : fallback;
type CodexNetworkCheckStartRefusalCode =
  'codex-network-check-busy' | 'codex-network-check-stale' | 'codex-network-check-expired';
/** Only the exact Start response contract may construct a definite pre-admission refusal. */
export class CodexNetworkCheckStartRefusal extends Error {
  private constructor(readonly code: CodexNetworkCheckStartRefusalCode) {
    super(CODEX_NETWORK_ERROR_MESSAGES[code]);
    this.name = 'CodexNetworkCheckStartRefusal';
    Object.freeze(this);
  }
  static fromResponse(code: unknown, status: number): CodexNetworkCheckStartRefusal | null {
    if (
      status !== 409 ||
      typeof code !== 'string' ||
      ![
        'codex-network-check-busy',
        'codex-network-check-stale',
        'codex-network-check-expired',
      ].includes(code)
    )
      return null;
    return new CodexNetworkCheckStartRefusal(code as CodexNetworkCheckStartRefusalCode);
  }
}
export function createCodexNetworkCheckStartRefusal(code: unknown, status: number) {
  return CodexNetworkCheckStartRefusal.fromResponse(code, status);
}
export const NETWORK_PENDING_LIMIT = 8;
export type GuardPending = { preview: CodexNetworkGuardPreview; startedAt: string };
export type CheckPending = {
  action: 'start' | 'cancel';
  id: string;
  operationId: string;
  binding: CodexNetworkCheckBinding;
  startedAt: string;
};
const guards = new WeakMap<NetworkTransport, Map<string, GuardPending>>(),
  checks = new WeakMap<NetworkTransport, Map<string, CheckPending>>(),
  listeners = new WeakMap<NetworkTransport, Set<() => void>>();
const key = (context: string, id: string) => `${context}:${id}`;
export function codexNetworkGuardPending(transport: NetworkTransport) {
  let map = guards.get(transport);
  if (!map) {
    map = new Map();
    guards.set(transport, map);
  }
  return map;
}
export function codexNetworkCheckPending(transport: NetworkTransport) {
  let map = checks.get(transport);
  if (!map) {
    map = new Map();
    checks.set(transport, map);
  }
  return map;
}
export function subscribeCodexNetworkPending(transport: NetworkTransport, listener: () => void) {
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
export function notifyCodexNetworkPending(transport: NetworkTransport) {
  listeners.get(transport)?.forEach((fn) => fn());
}
export function networkBindingMatches(a: CodexNetworkGuardBinding, b: CodexNetworkGuardBinding) {
  return (
    [
      'controlContextId',
      'captureSha256',
      'configSha256',
      'runtimeSha256',
      'nativeBinarySha256',
      'sourceGraphSha256',
    ] as const
  ).every((k) => a[k] === b[k]);
}
export function guardPreviewMatches(
  value: unknown,
  request: CodexNetworkGuardSelection | CodexNetworkGuardRestoreSelection,
  capture: CodexNetworkGuardCapture | null,
): value is CodexNetworkGuardPreview {
  if (
    !validateCodexNetworkGuardPreview(value) ||
    value.controlContextId !== request.controlContextId ||
    value.operation !== request.operation ||
    Date.parse(value.expiresAt) <= Date.now()
  )
    return false;
  if (request.operation === 'restore')
    return value.recordId === request.recordId && value.recordRevision === request.recordRevision;
  return (
    !!capture?.binding &&
    !!value.binding &&
    networkBindingMatches(value.binding, capture.binding) &&
    value.binding.captureSha256 === request.captureSha256 &&
    value.kind === capture.actionKind &&
    value.filesystemEffect === capture.filesystemEffect &&
    value.beforeSha256 === capture.binding.configSha256
  );
}
export function guardReceiptMatches(
  value: unknown,
  p: CodexNetworkGuardPreview,
  recheck = false,
): value is CodexNetworkGuardReceipt {
  return (
    validateCodexNetworkGuardReceipt(value) &&
    value.controlContextId === p.controlContextId &&
    value.operationId === p.operationId &&
    value.record.id === p.recordId &&
    value.record.kind === p.kind &&
    value.operation === (recheck ? 'recheck' : p.operation) &&
    value.checkedAt >= p.createdAt &&
    (p.operation !== 'guard' ||
      (value.record.originalSha256 === p.beforeSha256 &&
        value.record.candidateSha256 === p.afterSha256)) &&
    (!value.writeConfirmed ||
      value.record.operationStatus === (p.operation === 'guard' ? 'guarded' : 'restored'))
  );
}
export function confirmNetworkGuard(
  transport: NetworkTransport,
  receipt: CodexNetworkGuardReceipt,
) {
  const map = codexNetworkGuardPending(transport),
    k = key(receipt.controlContextId, receipt.record.id),
    write = map.get(k);
  if (
    !write ||
    !receipt.writeConfirmed ||
    !guardReceiptMatches(receipt, write.preview, receipt.operation === 'recheck') ||
    receipt.checkedAt < write.startedAt
  )
    return false;
  map.delete(k);
  notifyCodexNetworkPending(transport);
  return true;
}
export function checkPreviewMatches(
  value: unknown,
  capture: CodexNetworkGuardCapture,
  workspaceId: string,
): value is CodexNetworkCheckPreview {
  return (
    validateCodexNetworkCheckPreview(value) &&
    !!capture.binding &&
    capture.canCheck &&
    value.binding.workspaceId === workspaceId &&
    networkBindingMatches(value.binding, capture.binding) &&
    Date.parse(value.expiresAt) > Date.now()
  );
}
export function checkJobMatches(
  value: unknown,
  expected: Pick<CheckPending, 'id' | 'operationId' | 'binding'>,
): value is CodexNetworkCheckJob {
  return (
    validateCodexNetworkCheckJob(value) &&
    value.id === expected.id &&
    value.operationId === expected.operationId &&
    networkBindingMatches(value.binding, expected.binding) &&
    value.binding.workspaceId === expected.binding.workspaceId &&
    value.binding.profileCopySha256 === expected.binding.profileCopySha256 &&
    value.binding.suiteSha256 === expected.binding.suiteSha256 &&
    value.binding.copyKind === expected.binding.copyKind
  );
}
export function confirmNetworkCheck(transport: NetworkTransport, job: CodexNetworkCheckJob) {
  const map = codexNetworkCheckPending(transport),
    k = key(job.binding.controlContextId, job.id),
    pending = map.get(k);
  if (
    !pending ||
    !checkJobMatches(job, pending) ||
    (pending.action === 'cancel' && job.status === 'running')
  )
    return false;
  map.delete(k);
  notifyCodexNetworkPending(transport);
  return true;
}
/** A new explicit Start may recover a retained unowned attempt; it never retries or clears it. */
export function networkCheckAdmissionPendingMatches(
  state: CodexNetworkCheckState | null,
  pending: readonly CheckPending[],
  controlContextId: string | null | undefined,
  workspaceId: string | null,
) {
  if (!pending.length) return true;
  if (
    !state ||
    state.history !== 'ready' ||
    state.ownedJobId !== null ||
    state.controlContextId !== controlContextId ||
    state.workspaceId !== workspaceId
  )
    return false;
  return pending.every(
    (p) =>
      p.binding.controlContextId === controlContextId &&
      p.binding.workspaceId === workspaceId &&
      state.jobs.some(
        (j) => j.status === 'running' && j.id === state.activeJobId && checkJobMatches(j, p),
      ),
  );
}
export function networkCheckOwned(
  state: CodexNetworkCheckState | null,
  job: CodexNetworkCheckJob | null,
  controlContextId: string | null | undefined,
  workspaceId: string | null,
) {
  return (
    !!job &&
    job.status === 'running' &&
    state?.ownedJobId === job.id &&
    job.binding.controlContextId === controlContextId &&
    job.binding.workspaceId === workspaceId &&
    state.jobs.some((j) => j.status === 'running' && checkJobMatches(job, j))
  );
}
export const networkPendingKey = key;
