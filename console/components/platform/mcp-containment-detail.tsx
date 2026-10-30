'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { Badge, ExportButton } from '@/components/platform-ui';
import { CopyLocalLink } from '@/components/local-link';
import { INVENTORY_AGENTS } from '@/lib/inventory';
import type {
  McpContainmentRecord,
  McpContainmentReceipt,
  McpConfigSource,
} from '@/lib/mcp-containment';
import { McpContainmentAction } from './mcp-containment-action';
import { mcpContainmentCanRestore, mcpRecordBelongsElsewhere } from '@/lib/mcp-containment-binding';
export { mcpRecordBelongsElsewhere } from '@/lib/mcp-containment-binding';

export const MCP_SOURCE_LABELS: Record<McpConfigSource, string> = {
  'claude-code-project': 'Claude Code project configuration',
  'claude-desktop-user': 'Claude Desktop manual configuration',
  'cursor-project': 'Cursor workspace configuration',
  'cursor-user': 'Cursor user configuration',
};
export const MCP_STATUS_LABELS: Record<McpContainmentRecord['status'], string> = {
  removed: 'Absent from source',
  configured: 'Wrapper configured',
  reappeared: 'Registration reappeared',
  restored: 'Registration restored',
  changed: 'Evidence changed',
  'config-missing': 'Configuration missing',
  'recovery-required': 'Recovery needed',
  unverifiable: 'Not verified',
};
export const mcpContainmentNeedsAttention = (record: McpContainmentRecord) =>
  (record.status !== 'removed' && record.status !== 'restored' && record.status !== 'configured') ||
  (record.status === 'configured' && record.proxy?.runtimeMatches !== true);

export function McpContainmentDetail({
  record,
  workspaceId,
  href,
  limitations,
  disabled,
  onClose,
  onReturnFocus,
  onCompleted,
  onNeedsRecheck,
}: {
  record: McpContainmentRecord | null;
  workspaceId: string;
  href: string;
  limitations: string[];
  disabled: boolean;
  onClose: () => void;
  onReturnFocus: () => void;
  onCompleted: (receipt: McpContainmentReceipt) => void;
  onNeedsRecheck: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const foreign = record ? mcpRecordBelongsElsewhere(record, workspaceId) : false;
  const canRestore = record && mcpContainmentCanRestore(record, workspaceId);
  return (
    <Dialog.Root
      open={record !== null}
      onOpenChange={(open) => {
        if (!open && !applying) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content mcp-containment-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title>{record?.artifact.name ?? 'Retained MCP registration'}</Dialog.Title>
            <Dialog.Description>
              {record
                ? `${INVENTORY_AGENTS[record.artifact.agent]} · ${record.artifact.scope === 'user' ? 'User · multiple workspaces' : 'Workspace'} · configuration evidence`
                : 'Configuration evidence'}
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              disabled={applying}
              aria-label="Close retained registration"
            >
              <X size={19} />
            </Dialog.Close>
          </div>
          {record && (
            <div className="inventory-review-body">
              <Badge tone={foreign || mcpContainmentNeedsAttention(record) ? 'orange' : 'muted'}>
                {foreign ? 'Different workspace' : MCP_STATUS_LABELS[record.status]}
              </Badge>
              <div className="artifact-tools">
                <CopyLocalLink href={href} />
                <ExportButton
                  filename={'stroq-mcp-registration-' + record.id + '.json'}
                  label="Export evidence"
                  data={() => ({
                    schema: 'stroq-mcp-registration-export/2',
                    exportedAt: new Date().toISOString(),
                    workspaceId,
                    evidence: 'configuration',
                    hostEnforcement: false,
                    record,
                    limitations,
                  })}
                />
              </div>
              {foreign && (
                <p className="mcp-operation-notice">
                  This project registration belongs to another workspace. Its current configuration
                  was not read here. Open its original workspace to recheck or restore it.
                </p>
              )}
              <dl className="property-list">
                <div>
                  <dt>Configuration source</dt>
                  <dd>{MCP_SOURCE_LABELS[record.artifact.configSource]}</dd>
                </div>
                <div>
                  <dt>Registration slot</dt>
                  <dd>
                    {record.slot === 'absent'
                      ? 'Entry absent'
                      : record.slot === 'same'
                        ? 'Original version present'
                        : record.slot === 'guarded'
                          ? 'Exact Stroq wrapper present'
                          : record.slot === 'different'
                            ? 'Different version present'
                            : 'Not verified'}
                  </dd>
                </div>
                <div>
                  <dt>Recovery copies</dt>
                  <dd>
                    {record.payload === 'match'
                      ? 'Fingerprints match'
                      : record.payload === 'changed'
                        ? 'Changed'
                        : record.payload === 'missing'
                          ? 'Missing'
                          : 'Not verified'}
                  </dd>
                </div>
                <div>
                  <dt>Whole configuration</dt>
                  <dd>
                    {record.sourceMatchesChange === true
                      ? 'Matches change-time bytes'
                      : record.sourceMatchesChange === false
                        ? 'Differs from change-time bytes'
                        : 'Not verified'}
                  </dd>
                </div>
                {record.proxy && (
                  <>
                    <div>
                      <dt>Workspace context</dt>
                      <dd>
                        {record.proxy.policyWorkspaceId === workspaceId
                          ? 'This workspace'
                          : 'Original workspace'}
                        {record.artifact.scope === 'user' ? ' · shared across workspaces' : ''}
                      </dd>
                    </div>
                    <div>
                      <dt>Recorded proxy runtime</dt>
                      <dd>
                        {record.proxy.runtimeMatches === true
                          ? 'Fingerprint matches'
                          : record.proxy.runtimeMatches === false
                            ? 'Runtime changed'
                            : 'Not verified'}
                      </dd>
                    </div>
                  </>
                )}
                {record.proxy?.toolApproval && (
                  <div>
                    <dt>Tool contract review</dt>
                    <dd>Configured for future connections</dd>
                  </div>
                )}
                <div>
                  <dt>Last recheck</dt>
                  <dd>{new Date(record.checkedAt).toLocaleString('en-GB')}</dd>
                </div>
                <div>
                  <dt>Retained since</dt>
                  <dd>{new Date(record.createdAt).toLocaleString('en-GB')}</dd>
                </div>
                {record.restoredAt && (
                  <div>
                    <dt>Restore recorded</dt>
                    <dd>{new Date(record.restoredAt).toLocaleString('en-GB')}</dd>
                  </div>
                )}
              </dl>
              <details className="artifact-section">
                <summary>Exact configuration fingerprints</summary>
                <dl className="mcp-fingerprints">
                  <div>
                    <dt>Retained entry fingerprint</dt>
                    <dd>
                      <code className="inventory-digest">{record.artifact.sha256}</code>
                    </dd>
                  </div>
                  {record.changedEntrySha256 && (
                    <div>
                      <dt>Installed wrapper fingerprint</dt>
                      <dd>
                        <code className="inventory-digest">{record.changedEntrySha256}</code>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Current configuration fingerprint</dt>
                    <dd>
                      {record.configSha256 ? (
                        <code className="inventory-digest">{record.configSha256}</code>
                      ) : (
                        <span className="control-meta">Not verified in this workspace</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </details>
              {!foreign && record.status === 'removed' && (
                <p className="mcp-operation-notice">
                  This entry is absent from one configuration source. Active servers were not
                  checked or stopped; other sources may still provide it.
                </p>
              )}
              {!foreign && record.status === 'configured' && (
                <p className="mcp-operation-notice">
                  The exact wrapper is present in this source. Restart or reconnect the client; an
                  active guarded connection has not been verified.
                </p>
              )}
              {!foreign && record.proxy?.toolApproval && (
                <Link className="button" href="/skills/mcp/contracts/">
                  Review tool contracts
                </Link>
              )}
              {!foreign &&
                record.status === 'configured' &&
                record.proxy?.runtimeMatches !== true && (
                  <p className="control-error" role="status">
                    {record.proxy?.runtimeMatches === false
                      ? 'The recorded proxy runtime changed.'
                      : 'The recorded proxy runtime could not be verified.'}{' '}
                    Recheck before relying on this configuration.
                  </p>
                )}
              {!foreign &&
                record.status !== 'configured' &&
                mcpContainmentNeedsAttention(record) && (
                  <p className="mcp-operation-notice">
                    Inspect the current slot and retained copies before another action. A previous
                    operation does not establish the current client or server state.
                  </p>
                )}
              {!foreign && !canRestore && (
                <p className="control-meta">
                  {record.change === 'protect-registration'
                    ? 'Removing the proxy requires the exact installed wrapper and intact recovery copies.'
                    : 'Restore requires a free registration slot and intact recovery copies.'}{' '}
                  <Link href="/skills/?kind=mcp" className="inline-link">
                    Inspect installed MCP entries
                  </Link>
                </p>
              )}
              {canRestore && (
                <McpContainmentAction
                  key={record.id + record.checkedAt}
                  action="restore-registration"
                  artifact={record.artifact}
                  recordId={record.id}
                  recordProxy={record.proxy}
                  workspaceId={workspaceId}
                  disabled={disabled}
                  onCompleted={onCompleted}
                  onBusyChange={setApplying}
                  onNeedsRecheck={onNeedsRecheck}
                />
              )}
              <details className="artifact-section">
                <summary>Scope & private retention</summary>
                {limitations.map((limit) => (
                  <p className="control-meta" key={limit}>
                    {limit}
                  </p>
                ))}
              </details>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
