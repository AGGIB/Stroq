import type {
  McpContainmentArtifact,
  McpContainmentApplyRequest,
  McpContainmentPreview,
  McpContainmentReceipt,
  McpContainmentRecord,
  McpProxyConfiguration,
} from './mcp-containment';

export type McpContainmentTarget = Pick<
  McpContainmentArtifact,
  'id' | 'name' | 'scope' | 'sha256'
> & {
  agent: McpContainmentArtifact['agent'] | 'windsurf';
};
const sameArtifact = (left: McpContainmentArtifact, right: McpContainmentTarget) =>
  left.id === right.id &&
  left.agent === right.agent &&
  left.scope === right.scope &&
  left.sha256 === right.sha256;
const sameProxy = (left: McpProxyConfiguration | null, right: McpProxyConfiguration | null) =>
  left === null || right === null
    ? left === right
    : left.mode === right.mode &&
      left.policyWorkspaceId === right.policyWorkspaceId &&
      left.toolApproval === right.toolApproval;

export function mcpRecordBelongsElsewhere(
  record: McpContainmentRecord,
  workspaceId: string | null,
) {
  return record.artifact.scope === 'project' && record.originWorkspaceId !== workspaceId;
}
export function mcpContainmentCanRestore(record: McpContainmentRecord, workspaceId: string | null) {
  return (
    workspaceId !== null &&
    !mcpRecordBelongsElsewhere(record, workspaceId) &&
    record.status !== 'unverifiable' &&
    record.status !== 'config-missing' &&
    record.payload === 'match' &&
    (record.change === 'protect-registration'
      ? record.slot === 'guarded' && record.changedEntrySha256 !== null && record.proxy !== null
      : record.slot === 'absent') &&
    record.configSha256 !== null
  );
}

export function mcpContainmentPreviewMatches(
  preview: McpContainmentPreview,
  action: McpContainmentPreview['action'],
  artifact: McpContainmentTarget,
  workspaceId: string,
  recordId?: string,
  recordProxy: McpProxyConfiguration | null = null,
  toolApproval = false,
) {
  const expectedProxy =
    action === 'protect-registration'
      ? {
          mode: 'strict' as const,
          policyWorkspaceId: workspaceId,
          ...(toolApproval ? { toolApproval: true as const } : {}),
        }
      : action === 'restore-registration'
        ? recordProxy
        : null;
  return (
    preview.action === action &&
    preview.workspaceId === workspaceId &&
    sameArtifact(preview.artifact, artifact) &&
    sameProxy(preview.proxy, expectedProxy) &&
    (action !== 'restore-registration' || preview.recordId === recordId)
  );
}
export function mcpContainmentReceiptMatches(
  receipt: McpContainmentReceipt,
  preview: McpContainmentPreview,
) {
  return (
    receipt.previewId === preview.id &&
    receipt.recordId === preview.recordId &&
    receipt.action === preview.action &&
    receipt.workspaceId === preview.workspaceId &&
    sameArtifact(receipt.artifact, preview.artifact) &&
    receipt.artifact.configSource === preview.artifact.configSource &&
    receipt.configSha256 === preview.candidateSha256 &&
    sameProxy(receipt.proxy, preview.proxy) &&
    receipt.status ===
      (preview.action === 'protect-registration'
        ? 'configured'
        : preview.action === 'remove-registration'
          ? 'removed'
          : 'restored') &&
    receipt.completedAt >= preview.createdAt
  );
}
export interface McpContainmentAcknowledgements {
  session: boolean;
  retention: boolean;
  proxy: boolean;
  sharedPolicy: boolean;
  toolContracts?: boolean;
}
export function mcpContainmentApplyInput(
  preview: McpContainmentPreview,
  acknowledged: McpContainmentAcknowledgements,
): McpContainmentApplyRequest | null {
  const shared = preview.action === 'protect-registration' && preview.artifact.scope === 'user';
  if (
    !acknowledged.session ||
    !acknowledged.retention ||
    (preview.proxy !== null && !acknowledged.proxy) ||
    (shared && !acknowledged.sharedPolicy) ||
    (preview.action === 'protect-registration' &&
      preview.proxy?.toolApproval === true &&
      !acknowledged.toolContracts)
  )
    return null;
  return {
    previewId: preview.id,
    confirm: true,
    acknowledgeSessionLimits: true,
    acknowledgePrivateRetention: true,
    ...(preview.proxy === null ? {} : { acknowledgeProxyEffects: true }),
    ...(shared ? { acknowledgeSharedPolicyContext: true } : {}),
    ...(preview.action === 'protect-registration' && preview.proxy?.toolApproval
      ? { acknowledgeToolContracts: true as const }
      : {}),
  };
}
