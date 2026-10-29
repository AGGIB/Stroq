'use client';
import type { Ref } from 'react';
import type { CredentialFilterPreview, CredentialFilterBackup } from '@/lib/credential-filters';
import { CREDENTIAL_FILTER_TARGETS } from '@/lib/credential-filters';
import {
  CREDENTIAL_FILTER_PATTERNS,
  type CredentialFilterAcknowledgements,
} from '@/lib/credential-filter-binding';

export const FILTER_BACKUP_LABELS: Record<CredentialFilterBackup, string> = {
  copy: 'Private, unencrypted source copy',
  'none-new-file': 'New file · no previous source to copy',
  'none-credential-text': 'No source copy · credential-shaped text',
  'none-unchecked': 'No source copy · source could not be checked for copying',
  surgical: 'Surgical undo · preserve other settings',
  none: 'No complete source copy',
};
const OPERATIONS: Record<CredentialFilterPreview['operation'], string> = {
  create: 'Create fixed rules',
  update: 'Add missing rules',
  unchanged: 'No configuration change',
  'restore-copy': 'Restore verified source copy',
  'remove-managed': 'Remove managed entries only',
  'remove-created-file': 'Remove the file Stroq created',
  'clear-history': 'Clear managed history only',
};
export const filterContextLabel = (context: CredentialFilterPreview['context']) =>
  context === 'all-workspaces'
    ? 'All workspaces for this OS user'
    : context === 'repository'
      ? 'Repository · linked worktrees may be affected'
      : 'Selected workspace';

export function CredentialFilterPreviewDetails({
  preview,
  acknowledged,
  onAcknowledge,
  disabled,
  focusRef,
}: {
  preview: CredentialFilterPreview;
  acknowledged: CredentialFilterAcknowledgements;
  onAcknowledge: (key: keyof CredentialFilterAcknowledgements, value: boolean) => void;
  disabled: boolean;
  focusRef: Ref<HTMLInputElement>;
}) {
  const acknowledgements: [keyof CredentialFilterAcknowledgements, string][] = [
    [
      'acknowledgeNativeLimits',
      'I understand native rules are not an OS sandbox or proof that a read was blocked.',
    ],
    [
      'acknowledgePrivateRetention',
      'I accept the private, unencrypted backup strategy shown here and its retention limits.',
    ],
  ];
  if (preview.needs.acknowledgeSharedScope)
    acknowledgements.push([
      'acknowledgeSharedScope',
      preview.context === 'all-workspaces'
        ? 'Apply this change across workspaces for this OS user.'
        : 'Apply this repository setting, including its effect on linked worktrees.',
    ]);
  if (preview.needs.acknowledgeReformat)
    acknowledgements.push([
      'acknowledgeReformat',
      'I agree to the disclosed configuration reformatting.',
    ]);
  if (preview.needs.acknowledgeLink)
    acknowledgements.push([
      'acknowledgeLink',
      'I understand this linked configuration changes its resolved target.',
    ]);
  if (preview.needs.acknowledgeCredentialLoss)
    acknowledgements.push([
      'acknowledgeCredentialLoss',
      'I accept replacing credential-shaped data that a complete source copy cannot recover.',
    ]);
  if (preview.action === 'undo-filter')
    acknowledgements.push([
      'acknowledgeWeakenFilter',
      'I understand undo can weaken this explicit native filter.',
    ]);
  return (
    <>
      <dl className="property-list">
        <div>
          <dt>Source</dt>
          <dd>
            {CREDENTIAL_FILTER_TARGETS[preview.target].target}
            {preview.location === 'main-checkout'
              ? ' · main checkout'
              : preview.context === 'repository'
                ? ' · repository root'
                : ''}
          </dd>
        </div>
        <div>
          <dt>Effect</dt>
          <dd>{filterContextLabel(preview.context)}</dd>
        </div>
        <div>
          <dt>Planned change</dt>
          <dd>
            {preview.target === 'cursor-project' && preview.operation === 'update'
              ? 'Add managed ignore block'
              : OPERATIONS[preview.operation]}
          </dd>
        </div>
        <div>
          <dt>Rules</dt>
          <dd>
            {preview.present} present, {preview.added} added, {preview.removed} removed
          </dd>
        </div>
        <div>
          <dt>Recovery</dt>
          <dd>{FILTER_BACKUP_LABELS[preview.backup]}</dd>
        </div>
        {preview.reformatted && (
          <div>
            <dt>Layout</dt>
            <dd>Will be reformatted</dd>
          </div>
        )}
        {preview.action === 'undo-filter' && (
          <div>
            <dt>Recorded applications</dt>
            <dd>
              {preview.applications} · {preview.kept} modified entries kept
            </dd>
          </div>
        )}
      </dl>
      <div className="credential-filter-acks">
        {acknowledgements.map(([key, label], index) => (
          <label key={key}>
            <input
              ref={index === 0 ? focusRef : undefined}
              type="checkbox"
              checked={acknowledged[key]}
              disabled={disabled}
              onChange={(event) => onAcknowledge(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <details className="artifact-section">
        <summary>Fixed patterns · {preview.required}</summary>
        <ul className="credential-filter-patterns">
          {CREDENTIAL_FILTER_PATTERNS[preview.target].map((pattern) => (
            <li key={pattern}>
              <code>{pattern}</code>
            </li>
          ))}
        </ul>
        <p className="control-meta">
          The .env.* pattern includes .env.example. Existing user-owned rules are preserved.
        </p>
      </details>
      <details className="artifact-section">
        <summary>Native limits & private retention</summary>
        {preview.limitations.map((limit) => (
          <p className="control-meta" key={limit}>
            {limit}
          </p>
        ))}
        <p className="control-meta">{preview.retention}</p>
      </details>
      <details className="artifact-section">
        <summary>Exact preview fingerprints</summary>
        <dl className="mcp-fingerprints">
          <div>
            <dt>Current source</dt>
            <dd>
              {preview.sourceSha256 ? (
                <code className="inventory-digest">{preview.sourceSha256}</code>
              ) : (
                'File absent'
              )}
            </dd>
          </div>
          <div>
            <dt>Planned source</dt>
            <dd>
              {preview.candidateSha256 ? (
                <code className="inventory-digest">{preview.candidateSha256}</code>
              ) : (
                'File absent after this operation'
              )}
            </dd>
          </div>
        </dl>
        <p className="control-meta">
          Preview expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')}.
        </p>
      </details>
    </>
  );
}
