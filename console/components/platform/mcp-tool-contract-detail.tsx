'use client';
import { Dialog } from 'radix-ui';
import { LoaderCircle, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import type { McpToolContractRegistration, McpToolContractTool } from '@/lib/mcp-tool-contracts';
import type { useMcpToolContracts } from './use-mcp-tool-contracts';
import { mcpToolContractText } from '@/lib/mcp-tool-contract-presentation';
import { McpToolContractComparison } from './mcp-tool-contract-comparison';

export function toolContractLabel(
  registration: McpToolContractRegistration,
  tool: McpToolContractTool,
) {
  if (tool.decision === 'approved') return 'Approved version';
  if (tool.decision === 'revoked') return 'Approval revoked';
  return registration.history.some(
    (row) =>
      row.action === 'approve' && row.toolId === tool.id && row.contractSha256 !== tool.sha256,
  )
    ? 'Changed · needs review'
    : 'Needs review';
}
export function McpToolContractDetail({
  action,
  onClose,
}: {
  action: ReturnType<typeof useMcpToolContracts>;
  onClose: () => void;
}) {
  const { registration, tool, preview } = action;
  const reviewable = registration?.status === 'complete';
  const reviewed = preview?.tool ?? tool;
  return (
    <Dialog.Root
      open={tool !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content mcp-tool-contract-dialog">
          <div className="dialog-header">
            <Dialog.Title>{tool ? mcpToolContractText(tool.name) : 'Tool contract'}</Dialog.Title>
            <Dialog.Description>
              {registration?.name} ·{' '}
              {registration?.scope === 'user' ? 'User registration' : 'Workspace registration'}
            </Dialog.Description>
            <Dialog.Close className="dialog-close icon-button" aria-label="Close tool contract">
              <X size={19} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {registration && tool && (
            <div className="inventory-review-body">
              <Badge tone={tool.decision === 'pending' ? 'orange' : 'muted'}>
                {toolContractLabel(registration, tool)}
              </Badge>
              {reviewed && (
                <McpToolContractComparison
                  comparison={reviewed.comparison}
                  contract={reviewed.contract}
                  previousApprovedContract={reviewed.previousApprovedContract}
                />
              )}
              {action.receipt && (
                <p className="control-meta" role="status">
                  <strong>
                    {action.receipt.action === 'approve'
                      ? 'Version approval recorded'
                      : 'Approval revocation recorded'}
                  </strong>
                  . This does not retry a call.
                </p>
              )}
              {!reviewable && (
                <p className="control-error" role="status">
                  The observed listing is incomplete. This version cannot be approved.
                </p>
              )}
              {preview && (
                <section className="mcp-tool-decision" aria-label="Exact decision preview">
                  <h3>
                    {preview.action === 'approve'
                      ? 'Approve this exact version'
                      : 'Revoke this approval'}
                  </h3>
                  <p className="control-meta">
                    Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
                  </p>
                  <label className="policy-ack">
                    <input
                      type="checkbox"
                      checked={action.ack.contract}
                      disabled={action.busy === 'apply'}
                      onChange={(event) => action.acknowledge('contract', event.target.checked)}
                    />
                    <span>
                      {preview.action === 'approve'
                        ? 'I reviewed this advertised contract and approve this exact version.'
                        : 'I want to revoke approval for this exact version.'}
                    </span>
                  </label>
                  <label className="policy-ack">
                    <input
                      type="checkbox"
                      checked={action.ack.callLimits}
                      disabled={action.busy === 'apply'}
                      onChange={(event) => action.acknowledge('callLimits', event.target.checked)}
                    />
                    <span>
                      I understand this affects later matching calls, does not retry or undo calls,
                      and ordinary Stroq policy still applies.
                    </span>
                  </label>
                </section>
              )}
              {action.error && (
                <p className="control-error" role="alert">
                  {action.error}
                </p>
              )}
              {action.needsRecheck && (
                <p className="control-error" role="status">
                  Decision completion is unknown. Recheck this exact tool before another action.
                </p>
              )}
              <div className="dialog-footer">
                {action.needsRecheck ? (
                  <button className="button" disabled={!!action.busy} onClick={action.refresh}>
                    Recheck this tool
                  </button>
                ) : preview ? (
                  <button
                    className="button primary"
                    disabled={!!action.busy || !action.ack.contract || !action.ack.callLimits}
                    onClick={() => void action.apply()}
                  >
                    {action.busy === 'apply' ? (
                      <LoaderCircle size={16} className="spin" aria-hidden="true" />
                    ) : null}
                    {preview.action === 'approve' ? 'Approve this version' : 'Revoke approval'}
                  </button>
                ) : (
                  <button
                    className="button"
                    disabled={!!action.busy || !reviewable || !action.state?.available}
                    onClick={() =>
                      void action.prepare(tool.decision === 'approved' ? 'revoke' : 'approve')
                    }
                  >
                    {action.busy === 'preview'
                      ? 'Preparing…'
                      : tool.decision === 'approved'
                        ? 'Preview revocation'
                        : 'Preview approval'}
                  </button>
                )}
              </div>
              <details className="artifact-section">
                <summary>Version & connection fingerprints</summary>
                <dl className="mcp-fingerprints">
                  <div>
                    <dt>Contract SHA</dt>
                    <dd>
                      <code className="inventory-digest">
                        {preview?.expectedContractSha256 ?? tool.sha256}
                      </code>
                    </dd>
                  </div>
                  {reviewed?.comparison.baselineSha256 && (
                    <div>
                      <dt>Baseline contract SHA</dt>
                      <dd>
                        <code className="inventory-digest">
                          {reviewed.comparison.baselineSha256}
                        </code>
                      </dd>
                    </div>
                  )}
                  {reviewed?.comparison.baselineApprovedAt && (
                    <div>
                      <dt>Baseline approved</dt>
                      <dd>
                        {new Date(reviewed.comparison.baselineApprovedAt).toLocaleString('en-GB')}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Registration SHA</dt>
                    <dd>
                      <code className="inventory-digest">{registration.registrationSha256}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Connection binding</dt>
                    <dd>
                      <code className="inventory-digest">{registration.bindingId}</code>
                    </dd>
                  </div>
                </dl>
              </details>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
