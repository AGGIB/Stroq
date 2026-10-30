import {
  validateCodexSkillControlPreview,
  validateCodexSkillControlReceipt,
  validateCodexSkillControlSelection,
  type CodexSkillControlError,
  type CodexSkillControlPreview,
  type CodexSkillControlReceipt,
  type CodexSkillControlSelection,
  type CodexSkillControlRestoreSelection,
  type CodexSkillControlRecord,
} from './codex-skill-controls';
import type { CodexSkillSourceItem, CodexSkillSourcesReport } from './codex-skill-sources';
export const CODEX_SKILL_CONTROL_ERROR_MESSAGES: Record<CodexSkillControlError, string> = {
  'codex-control-unavailable': 'Codex user configuration is unavailable.',
  'codex-control-stale': 'Source or configuration changed. Inspect again before a new preview.',
  'codex-control-incomplete': 'Complete entrypoint evidence is required for this change.',
  'codex-control-already-disabled': 'This path is already disabled by an existing user rule.',
  'codex-control-unsupported': 'This configuration cannot be changed safely here.',
  'codex-control-conflict': 'The owned declaration changed. Review the current configuration.',
  'codex-control-store-unavailable': 'Saved change storage could not be verified.',
  'codex-control-store-full':
    'Saved change storage is full. Existing recovery copies were retained.',
  'codex-control-recovery-required': 'Recheck the unfinished change before another action.',
  'codex-control-write-unconfirmed': 'Completion is unknown. Recheck this exact change.',
  'codex-control-runtime-changed': 'The analysis runtime changed. Inspect again.',
  'codex-control-consent-required': 'Confirm the scope and retained copies before applying.',
  'codex-control-busy': 'Another local operation is running. Try again when it finishes.',
};
export type CodexControlTransport = (
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;
export interface CodexSkillControlPending {
  preview: CodexSkillControlPreview;
  startedAt: string;
}
const writes = new WeakMap<CodexControlTransport, Map<string, CodexSkillControlPending>>();
const subscriptions = new WeakMap<CodexControlTransport, Set<() => void>>();
export const CODEX_SKILL_CONTROL_PENDING_LIMIT = 8;
export const codexSkillControlPendingKey = (
  p: Pick<CodexSkillControlPreview, 'controlContextId' | 'recordId'>,
) => `${p.controlContextId}:${p.recordId}`;
export function codexSkillControlPendingWrites(transport: CodexControlTransport) {
  let map = writes.get(transport);
  if (!map) {
    map = new Map();
    writes.set(transport, map);
  }
  return map;
}
export function subscribeCodexSkillControlPending(
  transport: CodexControlTransport,
  listener: () => void,
) {
  let listeners = subscriptions.get(transport);
  if (!listeners) {
    listeners = new Set();
    subscriptions.set(transport, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function notifyCodexSkillControlPending(transport: CodexControlTransport) {
  subscriptions.get(transport)?.forEach((fn) => fn());
}
export function classifyCodexSkillControlPending(
  transport: CodexControlTransport,
  controlContextId: string | null,
) {
  const all = [...codexSkillControlPendingWrites(transport).values()];
  return {
    pending: controlContextId
      ? all.filter((w) => w.preview.controlContextId === controlContextId)
      : [],
    foreignPending: controlContextId
      ? all.filter((w) => w.preview.controlContextId !== controlContextId)
      : [],
    unscopedPending: controlContextId ? [] : all,
  };
}
export function codexSkillDisableSelection(
  report: CodexSkillSourcesReport,
  item: CodexSkillSourceItem,
): CodexSkillControlSelection | null {
  const source = report.sources.find((s) => s.id === item.sourceId);
  if (
    !source ||
    source.status !== 'complete' ||
    !['agents', 'codex-legacy'].includes(source.family) ||
    !['enabled', 'not-specified'].includes(item.declaredState) ||
    item.metadata !== 'valid' ||
    item.scan.status === 'incomplete' ||
    !['ready', 'missing'].includes(report.settings.status)
  )
    return null;
  const request = {
    operation: 'disable' as const,
    controlContextId: report.context.controlContextId,
    sourceId: item.sourceId,
    candidateId: item.id,
    expectedEntrypointSha256: item.entrypointSha256,
    expectedConfigSha256: report.settings.sha256,
    expectedRuntimeSha256: report.runtimeSha256,
  };
  return validateCodexSkillControlSelection(request) ? request : null;
}
export function codexSkillControlPreviewMatches(
  value: unknown,
  request: CodexSkillControlSelection | CodexSkillControlRestoreSelection,
): value is CodexSkillControlPreview {
  if (
    !validateCodexSkillControlPreview(value) ||
    value.controlContextId !== request.controlContextId ||
    value.operation !== request.operation ||
    Date.parse(value.expiresAt) <= Date.now()
  )
    return false;
  if (request.operation === 'restore')
    return value.recordId === request.recordId && value.recordRevision === request.recordRevision;
  const b = value.binding;
  return (
    !!b &&
    b.controlContextId === request.controlContextId &&
    b.sourceId === request.sourceId &&
    b.candidateId === request.candidateId &&
    b.entrypointSha256 === request.expectedEntrypointSha256 &&
    b.runtimeSha256 === request.expectedRuntimeSha256 &&
    value.beforeSha256 === request.expectedConfigSha256
  );
}
export function codexSkillControlReceiptMatches(
  value: unknown,
  preview: CodexSkillControlPreview,
  recheck = false,
): value is CodexSkillControlReceipt {
  if (
    !validateCodexSkillControlReceipt(value) ||
    value.controlContextId !== preview.controlContextId ||
    value.operationId !== preview.operationId ||
    value.record.id !== preview.recordId ||
    value.operation !== (recheck ? 'recheck' : preview.operation) ||
    value.checkedAt < preview.createdAt
  )
    return false;
  if (
    preview.operation === 'disable' &&
    (value.record.originalSha256 !== preview.beforeSha256 ||
      value.record.candidateSha256 !== preview.afterSha256)
  )
    return false;
  return (
    !value.writeConfirmed ||
    value.record.operationStatus === (preview.operation === 'disable' ? 'disabled' : 'restored')
  );
}
export function confirmCodexSkillControlWrite(
  transport: CodexControlTransport,
  receipt: CodexSkillControlReceipt,
) {
  const pending = codexSkillControlPendingWrites(transport),
    key = `${receipt.controlContextId}:${receipt.record.id}`,
    write = pending.get(key);
  if (
    !write ||
    !receipt.writeConfirmed ||
    !codexSkillControlReceiptMatches(receipt, write.preview, receipt.operation === 'recheck') ||
    receipt.checkedAt < write.startedAt
  )
    return false;
  pending.delete(key);
  notifyCodexSkillControlPending(transport);
  return true;
}
export const codexSkillControlUnfinished = (record: CodexSkillControlRecord) =>
  ['prepared', 'restoring', 'unknown'].includes(record.operationStatus);
export function codexSkillControlMessage(error: unknown, fallback: string) {
  return error instanceof Error &&
    Object.values(CODEX_SKILL_CONTROL_ERROR_MESSAGES).includes(error.message)
    ? error.message
    : fallback;
}
