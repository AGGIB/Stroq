'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import {
  WORKSPACE_TASK_ERROR_MESSAGES,
  type WorkspaceTaskRecord,
} from '@/lib/workspace-task-controls';
import { workspaceTaskRecoveryHref } from '@/lib/workspace-task-controls-binding';
import { workspaceReviewHref } from '@/lib/workspace-review-navigation';
import type { useWorkspaceTaskControls } from './use-workspace-task-controls';

type Controls = ReturnType<typeof useWorkspaceTaskControls>;
const FILE_STATE: Record<WorkspaceTaskRecord['fileState'], string> = {
  'manual-version': 'Manual version present',
  'original-version': 'Original version present',
  changed: 'File changed since this operation',
  missing: 'Task file missing',
  unverifiable: 'Current file unverified',
};
const RECORD_STATE: Record<WorkspaceTaskRecord['status'], string> = {
  prepared: 'Change pending',
  manual: 'File change recorded',
  restoring: 'Restore pending',
  restored: 'Restore recorded',
  unchanged: 'Original file confirmed',
  uncertain: 'Completion unverified',
};
function Verification({ record }: { record: WorkspaceTaskRecord }) {
  const value = record.verification;
  if (!value) return <p className="control-meta">No post-change capture recorded.</p>;
  if (value.status === 'unavailable')
    return <p className="control-meta">Fresh static capture unavailable.</p>;
  return (
    <p className="control-meta">
      <Link className="inline-link" href={workspaceReviewHref(value.runId, record.workspaceId)}>
        {value.complete ? 'View static capture' : 'Partial static capture'}
      </Link>
      {!value.sourceMatches && ' · Captured source differs from this recorded version.'}
    </p>
  );
}
export function WorkspaceTaskOutcome({ controls }: { controls: Controls }) {
  const receipt = controls.receipt;
  if (!receipt) return null;
  return (
    <div className="mcp-history-outcome" role="status">
      <strong>
        {receipt.operation === 'recheck'
          ? 'Recovery record rechecked'
          : receipt.operation === 'restore'
            ? 'Restore confirmed'
            : 'File change confirmed'}
      </strong>
      <p className="control-meta">{FILE_STATE[receipt.record.fileState]} · .vscode/tasks.json</p>
      <Verification record={receipt.record} />
      <Link className="inline-link" href={workspaceTaskRecoveryHref(receipt.record)}>
        Open recovery record
      </Link>
    </div>
  );
}
export function WorkspaceTaskControlsDialog({
  controls,
  onReturnFocus,
}: {
  controls: Controls;
  onReturnFocus?: () => void;
}) {
  const first = useRef<HTMLInputElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null),
    opener = useRef<HTMLElement | null>(null);
  const restoring = controls.operation === 'restore',
    preview = controls.preview;
  const applying = controls.busy === 'apply';
  useEffect(() => {
    if (preview) first.current?.focus();
  }, [preview]);
  return (
    <Dialog.Root
      open={controls.open}
      onOpenChange={(open) => {
        if (!open) controls.close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content mcp-containment-dialog"
          onOpenAutoFocus={(event) => {
            const active = document.activeElement;
            opener.current =
              active instanceof HTMLElement && active !== document.body ? active : null;
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            const target = opener.current;
            opener.current = null;
            if (target?.isConnected && !target.matches(':disabled, [aria-disabled="true"]')) {
              event.preventDefault();
              target.focus();
            } else if (onReturnFocus) {
              event.preventDefault();
              onReturnFocus();
            }
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              {restoring ? 'Restore automatic task settings' : 'Make tasks manual'}
            </Dialog.Title>
            <Dialog.Description>.vscode/tasks.json · workspace configuration</Dialog.Description>
            <button
              className="dialog-close icon-button"
              aria-label="Close task change preview"
              disabled={applying}
              onClick={controls.close}
            >
              <X size={19} />
            </button>
          </div>
          <div className="inventory-review-body">
            {controls.error && (
              <p className="control-error" role="alert">
                {controls.error}
              </p>
            )}
            {controls.busy && (
              <p className="control-meta" role="status">
                <LoaderCircle size={16} className="spin" aria-hidden="true" />{' '}
                {applying ? 'Applying this exact file change…' : 'Preparing a read-only preview…'}
              </p>
            )}
            {preview && (
              <>
                <dl className="property-list">
                  <div>
                    <dt>On folder open</dt>
                    <dd>{preview.changes.folderOpen}</dd>
                  </div>
                  <div>
                    <dt>On worktree creation</dt>
                    <dd>{preview.changes.worktreeCreated}</dd>
                  </div>
                </dl>
                <p className="control-meta">Manual tasks preserved · formatting preserved</p>
                {!preview.binding.captureComplete && (
                  <p className="control-meta">
                    The original capture has gaps. This change covers this file only.
                  </p>
                )}
                <div className="mcp-acknowledgements">
                  <label>
                    <input
                      ref={first}
                      type="checkbox"
                      checked={controls.ack.effects}
                      disabled={applying}
                      onChange={(event) => controls.acknowledge('effects', event.target.checked)}
                    />
                    <span>
                      {restoring
                        ? 'I understand this restores automatic task triggers for future editor actions.'
                        : 'I understand this changes the shared workspace file and does not stop tasks already running.'}
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={controls.ack.retention}
                      disabled={applying}
                      onChange={(event) => controls.acknowledge('retention', event.target.checked)}
                    />
                    <span>
                      I agree to retain a complete original file, including private content,
                      unencrypted for recovery.
                    </span>
                  </label>
                </div>
                <details className="artifact-section">
                  <summary>Exact change & recovery</summary>
                  <dl className="mcp-fingerprints">
                    <div>
                      <dt>Before</dt>
                      <dd>
                        <code className="inventory-digest">{preview.beforeSha256}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>After</dt>
                      <dd>
                        <code className="inventory-digest">{preview.afterSha256}</code>
                      </dd>
                    </div>
                  </dl>
                  <p className="control-meta">
                    Expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')} · mode{' '}
                    {preview.sourceMode.toString(8)}
                  </p>
                  <p className="control-meta">
                    The recovery copy is kept locally without automatic deletion. The editor is not
                    started; active tasks and workspace trust are not checked.
                  </p>
                </details>
                <div className="mcp-action-buttons">
                  <button
                    className="button primary"
                    disabled={
                      !!controls.busy ||
                      controls.needsRecheck ||
                      !controls.ack.effects ||
                      !controls.ack.retention
                    }
                    onClick={() => void controls.apply()}
                  >
                    {restoring ? 'Restore task settings' : 'Make tasks manual'}
                  </button>
                  <button className="button" disabled={applying} onClick={controls.close}>
                    Cancel preview
                  </button>
                </div>
              </>
            )}
            {!preview && !controls.busy && (
              <button className="button" onClick={controls.close}>
                Close
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function WorkspaceTaskRecovery({
  controls,
  selection,
}: {
  controls: Controls;
  selection: { requested: boolean; invalid: boolean; recordId: string | null };
}) {
  const records = controls.state?.records ?? [],
    requestedId = selection.requested && !selection.invalid ? selection.recordId : null;
  const selected = requestedId ? records.find((record) => record.id === requestedId) : null;
  const target = useRef<HTMLElement | null>(null),
    focusRequest = useRef({ id: null as string | null, workspaceId: '', done: false });
  useEffect(() => {
    if (focusRequest.current.id !== requestedId)
      focusRequest.current = { id: requestedId, workspaceId: '', done: false };
    if (!requestedId || !selected || !controls.state?.available || !target.current) return;
    const request = focusRequest.current;
    if (request.done && request.workspaceId === controls.state.workspaceId) return;
    focusRequest.current = { id: requestedId, workspaceId: controls.state.workspaceId, done: true };
    target.current.focus({ preventScroll: true });
    target.current.scrollIntoView({ block: 'center' });
  }, [requestedId, selected, controls.state?.available, controls.state?.workspaceId]);
  return (
    <details className="live-details" open={selection.requested || controls.needsRecheck}>
      <summary>
        Task change recovery <span className="muted">{controls.state ? records.length : '—'}</span>
      </summary>
      <div className="artifact-tools">
        <button
          className="button small"
          disabled={!!controls.busy}
          onClick={() => void controls.refresh()}
        >
          <RefreshCw size={15} aria-hidden="true" /> Refresh history
        </button>
      </div>
      {controls.error && !controls.open && (
        <p className="control-error" role="alert">
          {controls.error}
        </p>
      )}
      {(!controls.state || !controls.state.available) && (
        <p className="control-meta">
          {controls.state?.error
            ? WORKSPACE_TASK_ERROR_MESSAGES[controls.state.error]
            : 'Recovery history is unavailable.'}
        </p>
      )}
      {selection.requested && (selection.invalid || !selected) && (
        <p className="control-error" role="status">
          Selected recovery record unavailable. No other record was selected.
        </p>
      )}
      {controls.needsRecheck && (
        <div className="control-error" role="status">
          <p>Completion is unknown. Recheck this change before another action.</p>
          {controls.unresolved.map((write) => (
            <button
              key={write.preview.recordId}
              className="button small"
              disabled={!!controls.busy}
              onClick={() => void controls.recheck(write.preview.recordId)}
            >
              Recheck change · {new Date(write.startedAt).toLocaleTimeString('en-GB')}
            </button>
          ))}
          {controls.unresolvedRecords
            .filter(
              (record) =>
                !controls.unresolved.some((write) => write.preview.recordId === record.id),
            )
            .map((record) => (
              <button
                key={record.id}
                className="button small"
                disabled={!!controls.busy}
                onClick={() => void controls.recheck(record.id)}
              >
                Recheck unfinished change · {new Date(record.createdAt).toLocaleTimeString('en-GB')}
              </button>
            ))}
        </div>
      )}
      {controls.state?.available && records.length === 0 && (
        <p className="control-meta">No retained task changes.</p>
      )}
      {records.map((record) => (
        <details className="artifact-section" key={record.id} open={requestedId === record.id}>
          <summary
            id={`task-control-${record.id}`}
            ref={selected?.id === record.id ? target : undefined}
          >
            .vscode/tasks.json · {RECORD_STATE[record.status]} ·{' '}
            {new Date(record.createdAt).toLocaleString('en-GB')}
          </summary>
          <p className="control-meta">{FILE_STATE[record.fileState]}</p>
          <Badge tone={record.recoveryAvailable ? 'muted' : 'orange'}>
            {record.recoveryAvailable ? 'Recovery copy available' : 'Recovery copy unavailable'}
          </Badge>
          <Verification record={record} />
          <p className="control-meta">
            Checked {new Date(record.updatedAt).toLocaleString('en-GB')}
          </p>
          <div className="mcp-action-buttons">
            <Link className="button small" href={workspaceTaskRecoveryHref(record)}>
              Open this record
            </Link>
            <button
              className="button small"
              disabled={!!controls.busy}
              onClick={() => void controls.recheck(record.id)}
            >
              Recheck record
            </button>
            {record.canRestore && (
              <button
                className="button small"
                disabled={!controls.canPrepare}
                onClick={() => void controls.prepareRestore(record)}
              >
                Preview restore
              </button>
            )}
          </div>
          <details className="artifact-section">
            <summary>Retained fingerprints</summary>
            <p className="control-meta">
              Original <code className="inventory-digest">{record.originalSha256}</code>
            </p>
            <p className="control-meta">
              Manual <code className="inventory-digest">{record.manualSha256}</code>
            </p>
          </details>
        </details>
      ))}
    </details>
  );
}
