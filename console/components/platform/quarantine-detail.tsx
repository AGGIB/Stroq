'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';
import { Badge, ExportButton } from '@/components/platform-ui';
import { CopyLocalLink } from '@/components/local-link';
import type { SkillQuarantineRecord, SkillQuarantineReceipt } from '@/lib/skill-quarantine';
import { QuarantineAction } from './quarantine-action';
import { InventorySource } from './inventory-source';
import { SKILL_SOURCES } from '@/lib/skill-sources';
export const QUARANTINE_LABELS: Record<SkillQuarantineRecord['status'], string> = {
  quarantined: 'Removed from path',
  reappeared: 'Reappeared',
  restored: 'Restored',
  'payload-changed': 'Retained files changed',
  'payload-missing': 'Retained files missing',
  'recovery-required': 'Recovery needed',
  unverifiable: 'Unverified',
};
export function quarantineNeedsAttention(record: SkillQuarantineRecord) {
  return !['quarantined', 'restored'].includes(record.status);
}
export function QuarantineDetail({
  record,
  workspaceId,
  href,
  limitations,
  disabled,
  onClose,
  onReturnFocus,
  onCompleted,
  onRechecked,
}: {
  record: SkillQuarantineRecord | null;
  workspaceId: string;
  href: string;
  limitations: string[];
  disabled: boolean;
  onClose: () => void;
  onReturnFocus: () => void;
  onCompleted: (receipt: SkillQuarantineReceipt) => void;
  onRechecked?: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const canRestore =
    record?.payload === 'match' &&
    record.original === 'absent' &&
    record.status !== 'restored' &&
    !record.restoreBlock;
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
          className="dialog-content inventory-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title>{record?.artifact.name ?? 'Retained version'}</Dialog.Title>
            <Dialog.Description>
              {record ? SKILL_SOURCES[record.artifact.skillSource].label : 'Skill source'} ·{' '}
              {record?.artifact.scope === 'user' ? 'User · all workspaces' : 'Workspace'} ·
              filesystem evidence
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              disabled={applying}
              aria-label="Close retained skill"
            >
              <X size={19} />
            </Dialog.Close>
          </div>
          {record && (
            <div className="inventory-review-body">
              <Badge tone={quarantineNeedsAttention(record) ? 'orange' : 'muted'}>
                {QUARANTINE_LABELS[record.status]}
              </Badge>
              <div className="inventory-review-source" aria-label="Retained source folder">
                <InventorySource item={{ ...record.artifact, kind: 'skill' }} />
              </div>
              <div className="artifact-tools">
                <CopyLocalLink href={href} />
                <ExportButton
                  filename={'stroq-retained-' + record.id + '.json'}
                  label="Export evidence"
                  data={() => ({
                    schema: 'stroq-quarantine-export/2',
                    exportedAt: new Date().toISOString(),
                    workspaceId,
                    record,
                    limitations,
                    evidence: 'discovery-path',
                    hostEnforcement: false,
                  })}
                />
              </div>
              <dl className="property-list">
                <div>
                  <dt>Original location</dt>
                  <dd>
                    {record.original === 'absent'
                      ? 'Folder absent'
                      : record.original === 'same'
                        ? 'Same version present'
                        : record.original === 'different'
                          ? 'Different version present'
                          : 'Could not verify'}
                  </dd>
                </div>
                <div>
                  <dt>Retained files</dt>
                  <dd>
                    {record.payload === 'match'
                      ? 'Fingerprint matches'
                      : record.payload === 'changed'
                        ? 'Fingerprint changed'
                        : record.payload === 'missing'
                          ? 'Missing'
                          : 'Could not verify'}
                  </dd>
                </div>
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
                    <dt>Restored</dt>
                    <dd>{new Date(record.restoredAt).toLocaleString('en-GB')}</dd>
                  </div>
                )}
              </dl>
              <code className="inventory-digest">{record.artifact.sha256}</code>
              {record.status === 'quarantined' && (
                <p className="quarantine-meaning">
                  This folder is outside its original source. Start a new agent session; loaded
                  instructions and other copies remain available.
                </p>
              )}
              {quarantineNeedsAttention(record) && (
                <p className="quarantine-meaning">
                  The last operation does not establish the current state. Retained files are
                  preserved; inspect both observations before taking another action.
                </p>
              )}
              {record.original !== 'absent' && record.status !== 'restored' && (
                <p className="control-meta">
                  Original folder is occupied. Restore will not replace it.{' '}
                  <Link className="inline-link" href="/skills/">
                    Review current inventory
                  </Link>
                </p>
              )}
              {record.restoreBlock && (
                <p className="control-meta" role="status">
                  {record.restoreBlock === 'overlapping-skill'
                    ? 'Contains nested skills. Multi-skill restore is unavailable.'
                    : 'Managed or plugin content requires separate recovery.'}
                </p>
              )}
              {canRestore && (
                <QuarantineAction
                  key={record.id}
                  action="restore"
                  artifact={record.artifact}
                  recordId={record.id}
                  workspaceId={workspaceId}
                  disabled={disabled}
                  onCompleted={onCompleted}
                  onRechecked={onRechecked}
                  onBusyChange={setApplying}
                />
              )}
              <details className="artifact-section">
                <summary>Scope & retention</summary>
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
