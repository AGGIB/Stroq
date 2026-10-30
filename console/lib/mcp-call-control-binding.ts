import {
  MCP_CALL_CONTROL_ERROR_MESSAGES,
  validateMcpCallControlPreview,
  validateMcpCallControlReceipt,
  validateMcpCallControlRecheck,
  type McpCallControlAction,
  type McpCallControlInspection,
  type McpCallControlPreview,
  type McpCallControlReceipt,
  type McpCallControlRecheck,
} from './mcp-call-controls';
import type {
  McpCallControlOverview,
  McpCallControlOverviewRow,
} from './mcp-call-control-overview';
import type { McpContainmentArtifact } from './mcp-containment';
export type McpCallControlTarget =
  | { kind: 'source'; id: string; expectedSha256: string }
  | { kind: 'recovery'; id: string; contextId: string | null }
  | { kind: 'retained'; state: McpCallControlOverview; row: McpCallControlOverviewRow };
export type CallControlView = Pick<
  McpCallControlInspection,
  | 'workspaceId'
  | 'contextId'
  | 'artifact'
  | 'proxyWorkspaceId'
  | 'reason'
  | 'controlId'
  | 'invocationSha256'
  | 'revision'
  | 'current'
  | 'observation'
> & { capability: McpCallControlInspection['capability'] | 'missing-registration' };
export type CallControlAck = {
  scope: boolean;
  weakening: boolean;
  shared: boolean;
  storage: boolean;
};
export const emptyCallControlAck = (): CallControlAck => ({
  scope: false,
  weakening: false,
  shared: false,
  storage: false,
});
export type CallControlPending = { preview: McpCallControlPreview; startedAt: string };
export type CallControlSetupRecovery = {
  workspaceId: string;
  contextId: string;
  controlId: string;
  candidate: NonNullable<McpCallControlOverviewRow['setupCandidate']>;
};
type RecheckIdentity = Pick<
  McpCallControlPreview,
  'workspaceId' | 'contextId' | 'operationId' | 'action' | 'controlId' | 'invocationSha256'
>;
const uncertain = new WeakMap<object, Map<string, CallControlPending>>();
export function callControlPending(transport: object) {
  let values = uncertain.get(transport);
  if (!values) {
    values = new Map();
    uncertain.set(transport, values);
  }
  return values;
}
export const callControlPendingKey = (
  preview: Pick<McpCallControlPreview, 'contextId' | 'operationId'>,
) => `${preview.contextId}:${preview.operationId}`;
export function classifyCallControlPending(
  transport: object,
  workspaceId: string | null,
  contextId: string | null,
  artifactId?: string | null,
) {
  const retained = [...callControlPending(transport).values()].filter(
    (w) =>
      w.preview.workspaceId === workspaceId &&
      (artifactId === undefined || w.preview.artifact.id === artifactId),
  );
  return {
    pending: contextId ? retained.filter((w) => w.preview.contextId === contextId) : [],
    foreignPending: contextId ? retained.filter((w) => w.preview.contextId !== contextId) : [],
    unscopedPending: contextId ? [] : retained,
  };
}
export const CALL_CONTROL_PENDING_LIMIT = 8;
export const CALL_CONTROL_UNKNOWN = 'Completion is unknown. Recheck this exact operation.';
export function callControlMessage(value: unknown, fallback: string) {
  return value instanceof Error &&
    Object.values(MCP_CALL_CONTROL_ERROR_MESSAGES).includes(value.message)
    ? value.message
    : fallback;
}
export function callControlTargetId(target: McpCallControlTarget | null) {
  return target?.kind === 'source' || target?.kind === 'recovery'
    ? target.id
    : (target?.row.artifact?.id ?? null);
}
export function callControlTargetKey(target: McpCallControlTarget | null) {
  return target?.kind === 'source'
    ? `${target.id}:${target.expectedSha256}`
    : target?.kind === 'recovery'
      ? `recovery:${target.id}:${target.contextId}`
      : target
        ? `${target.row.controlId}:${target.state.contextId}:${target.state.checkedAt}`
        : null;
}
export function callControlRetainedView(
  target: McpCallControlTarget | null,
): CallControlView | null {
  if (target?.kind !== 'retained' || !target.row.artifact) return null;
  return {
    ...target.row,
    artifact: target.row.artifact,
    workspaceId: target.state.workspaceId,
    contextId: target.state.contextId,
    revision: target.state.revision,
  };
}
export function callControlCanPrepare(
  view: CallControlView | null,
  action: McpCallControlAction,
  retained = false,
) {
  if (!view || !view.proxyWorkspaceId) return false;
  if (retained) return action === 'pause' && view.current?.mode === 'enabled';
  if (action === 'setup') return view.capability === 'setup-required' && view.current === null;
  if (action === 'pause')
    return ['supported', 'drifted'].includes(view.capability) && view.current?.mode === 'enabled';
  if (action === 'resume')
    return view.capability === 'supported' && view.current?.mode === 'paused';
  return view.capability === 'drifted' && view.current !== null;
}
const sameArtifact = (a: McpContainmentArtifact, b: McpContainmentArtifact, retained = false) =>
  a.id === b.id &&
  (retained || a.sha256 === b.sha256) &&
  a.kind === b.kind &&
  a.name === b.name &&
  a.agent === b.agent &&
  a.scope === b.scope &&
  a.digestFormat === b.digestFormat &&
  a.configSource === b.configSource;
export function callControlPreviewMatches(
  value: unknown,
  view: CallControlView,
  action: McpCallControlAction,
  retained = false,
): value is McpCallControlPreview {
  return (
    validateMcpCallControlPreview(value) &&
    value.workspaceId === view.workspaceId &&
    value.contextId === view.contextId &&
    value.proxyWorkspaceId === view.proxyWorkspaceId &&
    sameArtifact(value.artifact, view.artifact, retained && action === 'pause') &&
    value.action === action &&
    value.expectedRevision === view.revision &&
    value.expectedEventId === (view.current?.eventId ?? null) &&
    (action === 'setup' || value.controlId === view.controlId) &&
    value.invocationSha256 ===
      (action === 'pause' ? view.current?.invocationSha256 : view.invocationSha256)
  );
}
export function callControlApplyInput(p: McpCallControlPreview, ack: CallControlAck) {
  if (
    !ack.scope ||
    (p.action === 'resume' && !ack.weakening) ||
    (p.sharedUserScope && !ack.shared) ||
    (p.changesConfiguration && !ack.storage)
  )
    return null;
  return {
    previewId: p.id,
    confirm: true,
    acknowledgeScope: true,
    acknowledgeWeakening: true,
    acknowledgeSharedScope: true,
    acknowledgeLocalStorage: true,
  } as const;
}
export function callControlReceiptMatches(
  value: unknown,
  p: McpCallControlPreview,
  startedAt: string,
): value is McpCallControlReceipt {
  return (
    validateMcpCallControlReceipt(value) &&
    value.previewId === p.id &&
    value.operationId === p.operationId &&
    value.workspaceId === p.workspaceId &&
    value.contextId === p.contextId &&
    value.proxyWorkspaceId === p.proxyWorkspaceId &&
    value.action === p.action &&
    sameArtifact(value.artifact, p.artifact) &&
    value.controlId === p.controlId &&
    value.invocationSha256 === p.invocationSha256 &&
    value.expectedEventId === p.expectedEventId &&
    value.completedAt >= startedAt
  );
}
export function callControlRecheckMatches(
  value: unknown,
  write: CallControlPending,
): value is McpCallControlRecheck {
  return callControlRecheckCandidateMatches(value, write.preview, write.startedAt);
}
export function callControlRecheckCandidateMatches(
  value: unknown,
  p: RecheckIdentity,
  startedAt: string,
): value is McpCallControlRecheck {
  return (
    validateMcpCallControlRecheck(value) &&
    value.workspaceId === p.workspaceId &&
    value.contextId === p.contextId &&
    value.operationId === p.operationId &&
    value.action === p.action &&
    value.controlId === p.controlId &&
    value.invocationSha256 === p.invocationSha256 &&
    value.checkedAt >= startedAt
  );
}
export const callControlReceiptConfirmed = (value: McpCallControlReceipt) =>
  value.authority === 'confirmed' &&
  (value.action !== 'setup' || value.configuration === 'confirmed');
export const callControlRecheckConfirmed = (value: McpCallControlRecheck) =>
  value.authority === 'recorded' &&
  (value.action !== 'setup' || value.configuration === 'confirmed');
