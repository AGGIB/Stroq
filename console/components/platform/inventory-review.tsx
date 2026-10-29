'use client';
import { Dialog } from 'radix-ui';
import Link from 'next/link';
import { useState } from 'react';
import { QuarantineAction } from './quarantine-action';
import { McpContainmentAction } from './mcp-containment-action';
import { McpCallControl } from './mcp-call-control';
import type { SkillQuarantineReceipt } from '@/lib/skill-quarantine';
import type { McpContainmentReceipt } from '@/lib/mcp-containment';
import { Check, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Badge, ExportButton } from '@/components/platform-ui';
import { CopyLocalLink } from '@/components/local-link';
import { INVENTORY_AGENTS, INVENTORY_STATES, type InventoryItem } from '@/lib/inventory';
import { InventoryEvidencePanel } from './inventory-evidence';
import { InventoryChangesPanel } from './inventory-changes';
import { inventoryReviewDetailsLabel } from '@/lib/inventory-comparison-binding';
import { useInventoryEvidence } from './use-inventory';
import {
  quarantineArtifactFromInventory,
  quarantineUnavailableReason,
} from '@/lib/quarantine-binding';
import { InventorySource } from './inventory-source';
import { useInventorySignals } from './use-inventory-signals';
import { InventorySignalControls } from './inventory-signal-controls';

const supportsMcpContainment = (
  agent: InventoryItem['agent'],
): agent is 'claude-code' | 'claude-desktop' | 'cursor' =>
  agent === 'claude-code' || agent === 'claude-desktop' || agent === 'cursor';

export function InventoryBadge({ item }: { item: InventoryItem }) {
  return (
    <Badge
      tone={
        item.state === 'changed' || item.state === 'missing' || item.scan.status === 'suspect'
          ? 'orange'
          : 'muted'
      }
    >
      {INVENTORY_STATES[item.state]}
    </Badge>
  );
}
export function InventoryReview({
  selected,
  workspaceId,
  href,
  reviewing,
  reviewNeedsRecheck = false,
  loading,
  baselineInvalid,
  error,
  onClose,
  onReview,
  onReturnFocus,
  onQuarantined,
  onMcpCompleted,
  onNeedsRecheck,
  onRefreshInventory,
}: {
  selected: InventoryItem | null;
  workspaceId: string | null;
  href: string;
  reviewing: boolean;
  reviewNeedsRecheck?: boolean;
  loading: boolean;
  baselineInvalid: boolean;
  error: string | null;
  onClose: () => void;
  onReview: (item: InventoryItem) => Promise<void>;
  onReturnFocus: () => void;
  onQuarantined: (receipt: SkillQuarantineReceipt) => void;
  onMcpCompleted: (receipt: McpContainmentReceipt) => void;
  onNeedsRecheck: () => void;
  onRefreshInventory: () => void;
}) {
  const evidence = useInventoryEvidence(selected, workspaceId);
  // Both reads use the same bounded inventory worker slot. Admit the signal capture
  // only after the source-bound comparison has reached an accepted terminal result.
  const signals = useInventorySignals(
    evidence.report && !evidence.loading ? selected : null,
    workspaceId,
    { onChanged: onRefreshInventory },
  );
  const detailsLabel = selected ? inventoryReviewDetailsLabel(selected, evidence.comparison) : null;
  const [containmentBusy, setContainmentBusy] = useState(false);
  const [callControlBusy, setCallControlBusy] = useState(false);
  const actionBusy = containmentBusy || callControlBusy || signals.busy === 'apply';
  const inventoryBusy = containmentBusy || callControlBusy || Boolean(signals.busy);
  const mcpAgent = selected && supportsMcpContainment(selected.agent) ? selected.agent : null;
  const quarantineArtifact = selected ? quarantineArtifactFromInventory(selected) : null;
  const quarantineReason = selected ? quarantineUnavailableReason(selected) : null;
  return (
    <Dialog.Root
      open={selected !== null}
      onOpenChange={(open) => {
        if (!open && !reviewing && !actionBusy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content inventory-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title>{selected?.name ?? 'Artifact review'}</Dialog.Title>
            <Dialog.Description>
              {selected
                ? `${INVENTORY_AGENTS[selected.agent]} · ${selected.scope === 'project' ? 'Workspace' : 'User'} · ${selected.kind === 'skill' ? 'Skill' : 'MCP server'}`
                : ''}
            </Dialog.Description>
            <Dialog.Close
              disabled={reviewing || actionBusy}
              className="dialog-close icon-button"
              aria-label="Close artifact review"
            >
              <X size={19} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {selected && (
            <>
              <div className="inventory-review-body">
                <InventoryBadge item={selected} />
                <div className="inventory-review-source" aria-label="Artifact source">
                  <InventorySource item={selected} />
                </div>
                <div className="artifact-tools">
                  <CopyLocalLink href={href} />
                  {evidence.report && (
                    <ExportButton
                      data={() => ({
                        schema: 'stroq-artifact-export/3',
                        exportedAt: new Date().toISOString(),
                        report: evidence.report,
                        comparison: evidence.comparison,
                        signalDecision: signals.state,
                        signalDecisionCompletionUnknown: signals.needsRecheck,
                      })}
                      filename={`stroq-${selected.id}.json`}
                      label="Export evidence"
                    />
                  )}
                  {selected.sha256 && (
                    <button
                      className="button"
                      disabled={evidence.loading || reviewing || loading || inventoryBusy}
                      onClick={evidence.refresh}
                    >
                      <RefreshCw
                        size={16}
                        className={evidence.loading ? 'spin' : undefined}
                        aria-hidden="true"
                      />
                      Refresh details
                    </button>
                  )}
                </div>
                {selected.kind === 'mcp' && mcpAgent !== null && selected.sha256 && workspaceId && (
                  <McpCallControl
                    target={{ kind: 'source', id: selected.id, expectedSha256: selected.sha256 }}
                    enabled={Boolean(evidence.report && !evidence.loading && !signals.busy)}
                    disabled={
                      reviewing ||
                      loading ||
                      containmentBusy ||
                      Boolean(signals.busy) ||
                      evidence.loading ||
                      !evidence.report ||
                      selected.state === 'missing'
                    }
                    onBusyChange={setCallControlBusy}
                    onChanged={onRefreshInventory}
                  />
                )}
                {selected.kind === 'mcp' && mcpAgent !== null && selected.sha256 && workspaceId && (
                  <details className="artifact-section">
                    <summary>Configuration & recovery</summary>
                    {(
                      [
                        { action: 'protect-registration', toolApproval: false },
                        { action: 'protect-registration', toolApproval: true },
                        { action: 'remove-registration', toolApproval: false },
                      ] as const
                    ).map(({ action, toolApproval }) =>
                      action === 'protect-registration' &&
                      (selected.mcp?.transport !== 'stdio' ||
                        selected.mcp.wrapper !== 'not-configured')
                        ? null
                        : selected.sha256 && (
                            <McpContainmentAction
                              key={action + toolApproval + selected.id + selected.sha256}
                              action={action}
                              toolApproval={toolApproval}
                              artifact={{
                                id: selected.id,
                                name: selected.name,
                                agent: mcpAgent,
                                scope: selected.scope,
                                sha256: selected.sha256,
                              }}
                              workspaceId={workspaceId}
                              disabled={
                                reviewing ||
                                inventoryBusy ||
                                loading ||
                                evidence.loading ||
                                !evidence.report ||
                                selected.state === 'missing'
                              }
                              onCompleted={onMcpCompleted}
                              onBusyChange={setContainmentBusy}
                              onNeedsRecheck={onNeedsRecheck}
                            />
                          ),
                    )}
                  </details>
                )}
                {evidence.loading && (
                  <p className="control-meta" role="status">
                    <LoaderCircle size={16} className="spin" aria-hidden="true" /> Inspecting this
                    version…
                  </p>
                )}
                {evidence.error && (
                  <p className="control-error" role="alert">
                    {evidence.error}
                  </p>
                )}
                {(evidence.error || signals.error || !selected.sha256) && (
                  <button
                    className="button"
                    disabled={reviewing || loading || inventoryBusy}
                    onClick={onRefreshInventory}
                  >
                    <RefreshCw size={16} aria-hidden="true" /> Refresh inventory
                  </button>
                )}
                {evidence.comparison && <InventoryChangesPanel comparison={evidence.comparison} />}
                {evidence.report && (
                  <details
                    className="artifact-section"
                    open={
                      evidence.comparison?.baseline.status !== 'available' ||
                      ['suspect', 'incomplete'].includes(evidence.report.scan.status)
                    }
                  >
                    <summary>
                      Current inspection{' '}
                      <span>
                        {evidence.report.artifact.kind === 'mcp'
                          ? 'Configuration only'
                          : `${evidence.report.scan.findings} matched signals`}
                      </span>
                    </summary>
                    <InventoryEvidencePanel report={evidence.report} />
                  </details>
                )}
                {selected.kind === 'skill' && selected.sha256 && (
                  <InventorySignalControls
                    action={signals}
                    disabled={
                      reviewing ||
                      loading ||
                      containmentBusy ||
                      callControlBusy ||
                      evidence.loading ||
                      !evidence.report
                    }
                  />
                )}
                {quarantineArtifact && workspaceId && (
                  <QuarantineAction
                    key={selected.id + selected.sha256}
                    action="quarantine"
                    artifact={quarantineArtifact}
                    workspaceId={workspaceId}
                    disabled={
                      reviewing ||
                      loading ||
                      evidence.loading ||
                      inventoryBusy ||
                      !evidence.report ||
                      selected.state === 'missing'
                    }
                    onCompleted={onQuarantined}
                    onRechecked={onRefreshInventory}
                    onBusyChange={setContainmentBusy}
                  />
                )}
                {quarantineReason && (
                  <p className="control-meta" role="status">
                    {quarantineReason}
                  </p>
                )}
                {selected.kind === 'mcp' && selected.agent === 'windsurf' && (
                  <p className="control-meta">
                    Windsurf and Devin configuration evidence is read-only. Registration changes are
                    not supported here.
                  </p>
                )}
                {selected.kind === 'mcp' && selected.mcp?.strict && (
                  <Link className="button" href="/skills/mcp/contracts/">
                    Tool contract records
                  </Link>
                )}
                {!selected.sha256 && (
                  <p className="control-meta">
                    This item is missing or could not be captured safely. Detailed evidence is
                    unavailable.
                  </p>
                )}
                <details className="artifact-section">
                  <summary>Version fingerprints</summary>
                  <p className="control-meta">
                    Current · {evidence.report?.artifact.digestFormat ?? 'Inventory fingerprint'}
                  </p>
                  <code className="inventory-digest">{selected.sha256 ?? 'Unavailable'}</code>
                  {selected.reviewedSha256 && (
                    <>
                      <p className="control-meta">Reviewed</p>
                      <code className="inventory-digest">{selected.reviewedSha256}</code>
                    </>
                  )}
                </details>
                <p className="muted">Review grants no trust or protection.</p>
                {error && (
                  <p className="control-error" role="alert">
                    {error}
                  </p>
                )}
              </div>
              <div className="dialog-footer">
                {reviewNeedsRecheck && (
                  <button
                    className="button"
                    disabled={reviewing || loading || inventoryBusy}
                    onClick={onNeedsRecheck}
                  >
                    <RefreshCw size={16} aria-hidden="true" /> Recheck review status
                  </button>
                )}
                <button
                  className="button primary"
                  disabled={
                    reviewing ||
                    reviewNeedsRecheck ||
                    inventoryBusy ||
                    baselineInvalid ||
                    evidence.comparison?.baseline.status === 'invalid' ||
                    loading ||
                    evidence.loading ||
                    !evidence.report ||
                    evidence.report.scan.status === 'incomplete' ||
                    (selected.state === 'unchanged' && !detailsLabel) ||
                    selected.state === 'missing' ||
                    selected.state === 'unverifiable' ||
                    selected.scan.status === 'incomplete' ||
                    !selected.sha256
                  }
                  onClick={() => void onReview(selected)}
                >
                  {reviewing ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    <Check size={16} aria-hidden="true" />
                  )}
                  {reviewing
                    ? 'Recording…'
                    : detailsLabel
                      ? detailsLabel
                      : selected.state === 'unchanged'
                        ? 'Reviewed'
                        : 'Mark version reviewed'}
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
