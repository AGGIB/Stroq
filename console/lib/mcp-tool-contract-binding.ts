import type {
  McpToolContractRegistration,
  McpToolContractTool,
  McpToolContractPreview,
  McpToolContractReceipt,
  McpToolContractDecisionRequest,
  McpToolContractApplyRequest,
} from './mcp-tool-contracts';
import { sameMcpToolContractComparison } from './mcp-tool-contract-comparison';
export function mcpToolContractDecisionInput(
  registration: McpToolContractRegistration,
  tool: McpToolContractTool,
  action: 'approve' | 'revoke',
): McpToolContractDecisionRequest | null {
  if (
    registration.status !== 'complete' ||
    !registration.revision ||
    !registration.captureSha256 ||
    !registration.tools.includes(tool) ||
    (action === 'revoke' ? tool.decision !== 'approved' : tool.decision === 'approved')
  )
    return null;
  return {
    action,
    bindingId: registration.bindingId,
    expectedRevision: registration.revision,
    expectedCaptureSha256: registration.captureSha256,
    toolId: tool.id,
    expectedContractSha256: tool.sha256,
  };
}
export function mcpToolContractPreviewMatches(
  preview: McpToolContractPreview,
  registration: McpToolContractRegistration,
  tool: McpToolContractTool,
  action: 'approve' | 'revoke',
  workspaceId: string,
) {
  const expected = mcpToolContractDecisionInput(registration, tool, action);
  return (
    expected !== null &&
    preview.workspaceId === workspaceId &&
    preview.registrationId === registration.id &&
    preview.registrationSha256 === registration.registrationSha256 &&
    Object.entries(expected).every(
      ([key, value]) => preview[key as keyof McpToolContractPreview] === value,
    ) &&
    preview.tool.name === tool.name &&
    preview.tool.contract === tool.contract &&
    preview.tool.previousApprovedContract === tool.previousApprovedContract &&
    sameMcpToolContractComparison(preview.tool.comparison, tool.comparison)
  );
}
export function mcpToolContractReceiptMatches(
  receipt: McpToolContractReceipt,
  preview: McpToolContractPreview,
) {
  return (
    receipt.previewId === preview.id &&
    (
      [
        'workspaceId',
        'registrationId',
        'registrationSha256',
        'action',
        'bindingId',
        'expectedRevision',
        'expectedCaptureSha256',
        'toolId',
        'expectedContractSha256',
      ] as const
    ).every((key) => receipt[key] === preview[key]) &&
    receipt.completedAt >= preview.createdAt &&
    receipt.completedAt <= preview.expiresAt &&
    receipt.revision !== preview.expectedRevision
  );
}
export function mcpToolContractApplyInput(
  preview: McpToolContractPreview,
  contract: boolean,
  callLimits: boolean,
  now = Date.now(),
): McpToolContractApplyRequest | null {
  return contract && callLimits && now < Date.parse(preview.expiresAt)
    ? {
        previewId: preview.id,
        confirm: true,
        acknowledgeContract: true,
        acknowledgeCallLimits: true,
      }
    : null;
}
