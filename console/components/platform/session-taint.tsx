'use client';
import { useEffect, useRef } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, Search, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import {
  SESSION_TAINT_ERROR_MESSAGES,
  type SessionTaintInspection,
  type SessionTaintRecord,
} from '@/lib/session-taint';
import type { useSessionTaint } from './use-session-taint';

type Action = ReturnType<typeof useSessionTaint>;
function CurrentState({ current }: { current: SessionTaintInspection | null }) {
  return (
    <p className="control-meta">
      {!current
        ? 'Current state unavailable'
        : current.taint.status === 'clear'
          ? 'No stored taint at last check'
          : 'Session is suspect at last check'}
      {current && ` · ${new Date(current.checkedAt).toLocaleTimeString('en-GB')}`}
    </p>
  );
}
function Facts({ value }: { value: SessionTaintInspection }) {
  return (
    <>
      <dl className="property-list">
        <div>
          <dt>Stored taint</dt>
          <dd>
            <Badge tone={value.taint.status === 'suspect' ? 'orange' : 'muted'}>
              {value.taint.status === 'suspect' ? 'Suspect' : 'Clear'}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>Taint sources</dt>
          <dd>{value.taint.sources}</dd>
        </div>
        <div>
          <dt>Learned-origin records</dt>
          <dd>
            {value.provenance.records} · {value.provenance.suspect} suspect
          </dd>
        </div>
      </dl>
      {(value.provenance.pending > 0 ||
        value.provenance.incomplete ||
        value.provenance.digestsLost) && (
        <p className="control-meta">
          {[
            value.provenance.pending > 0 ? `${value.provenance.pending} pending operations` : null,
            value.provenance.incomplete ? 'Provenance incomplete' : null,
            value.provenance.digestsLost ? 'Digest history lost' : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <p className="control-meta">Checked {new Date(value.checkedAt).toLocaleString('en-GB')}</p>
    </>
  );
}
export function SessionTaintOutcome({ action }: { action: Action }) {
  const receipt = action.receipt;
  if (!receipt) return null;
  return (
    <div className="mcp-history-outcome" role="status">
      <strong>
        {receipt.writeConfirmed
          ? 'Stored taint clear confirmed'
          : receipt.record.status === 'unchanged'
            ? 'Original taint observed'
            : 'Completion unverified'}
      </strong>
      <CurrentState current={receipt.record.current} />
      {receipt.writeConfirmed && (
        <p className="control-meta">Learned origins and finding history preserved.</p>
      )}
    </div>
  );
}
const RECORD_STATE: Record<SessionTaintRecord['status'], string> = {
  prepared: 'Clear pending',
  cleared: 'Clear recorded',
  unchanged: 'Original taint observed',
  uncertain: 'Completion unverified',
};
export function SessionTaintPanel({
  action,
  disabled = false,
}: {
  action: Action;
  disabled?: boolean;
}) {
  const inspectBusy = action.busy === 'inspect';
  return (
    <section className="incident-task" aria-label="Stored session taint">
      <div className="incident-detail-tools">
        <button
          className="button"
          disabled={disabled || !!action.busy || !action.workspaceId}
          onClick={() => void action.inspect()}
        >
          {inspectBusy ? <LoaderCircle size={16} className="spin" /> : <Search size={16} />}Inspect
          session taint
        </button>
        {action.inspection && (
          <button
            className="button"
            disabled={disabled || !action.canPrepare}
            onClick={() => void action.prepare()}
          >
            Preview clear
          </button>
        )}
      </div>
      {action.inspection && <Facts value={action.inspection} />}
      {action.inspection?.provenance.pending !== undefined &&
        action.inspection.provenance.pending > 0 && (
          <p className="control-meta">Wait for pending operations, then inspect again.</p>
        )}
      <SessionTaintOutcome action={action} />
      {action.error && !action.open && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {!action.workspaceId && (
        <p className="control-meta">Connect the local workspace to inspect session state.</p>
      )}
      {action.state && !action.state.available && (
        <p className="control-error" role="status">
          {action.state.error
            ? SESSION_TAINT_ERROR_MESSAGES[action.state.error]
            : 'Session change history is unavailable.'}
        </p>
      )}
      {(action.records.length > 0 || action.needsRecheck || !action.state?.available) && (
        <details className="setup-next" open={action.needsRecheck}>
          <summary>
            Session change history{action.records.length > 0 ? ` · ${action.records.length}` : ''}
          </summary>
          <button
            className="button small"
            disabled={!!action.busy}
            onClick={() => void action.refresh()}
          >
            Refresh history
          </button>
          {action.needsRecheck && (
            <div className="control-error" role="status">
              <p>Completion is unknown. Recheck before clearing again.</p>
              {action.unresolved.map((write) => (
                <button
                  key={write.preview.recordId}
                  className="button small"
                  disabled={!!action.busy}
                  onClick={() => void action.recheck(write.preview.recordId)}
                >
                  Recheck change · {new Date(write.startedAt).toLocaleTimeString('en-GB')}
                </button>
              ))}
              {action.unresolvedRecords
                .filter(
                  (record) =>
                    !action.unresolved.some((write) => write.preview.recordId === record.id),
                )
                .map((record) => (
                  <button
                    key={record.id}
                    className="button small"
                    disabled={!!action.busy}
                    onClick={() => void action.recheck(record.id)}
                  >
                    Recheck change · Journal #{record.before.incident.sequence}
                  </button>
                ))}
            </div>
          )}
          {action.records.map((record) => (
            <details className="artifact-section" key={record.id}>
              <summary>
                {RECORD_STATE[record.status]} · {new Date(record.createdAt).toLocaleString('en-GB')}
              </summary>
              <CurrentState current={record.current} />
              {record.error && (
                <p className="control-meta">{SESSION_TAINT_ERROR_MESSAGES[record.error]}</p>
              )}
              <p className="control-meta">
                {record.recoveryAvailable
                  ? 'Private recovery copy retained'
                  : 'Private recovery copy unavailable'}
              </p>
              <button
                className="button small"
                disabled={!!action.busy}
                onClick={() => void action.recheck(record.id)}
              >
                Recheck record
              </button>
              <details className="artifact-section">
                <summary>Retained fingerprints</summary>
                <dl className="mcp-fingerprints">
                  <div>
                    <dt>Before taint</dt>
                    <dd>
                      <code className="inventory-digest">{record.before.taint.sha256}</code>
                    </dd>
                  </div>
                  {record.afterTaintSha256 && (
                    <div>
                      <dt>Confirmed after taint</dt>
                      <dd>
                        <code className="inventory-digest">{record.afterTaintSha256}</code>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Preserved provenance</dt>
                    <dd>
                      <code className="inventory-digest">
                        {record.preservedProvenanceSha256 ?? 'No preservation receipt'}
                      </code>
                    </dd>
                  </div>
                </dl>
              </details>
            </details>
          ))}
        </details>
      )}
    </section>
  );
}
export function SessionTaintDialog({
  action,
  onReturnFocus,
}: {
  action: Action;
  onReturnFocus?: () => void;
}) {
  const first = useRef<HTMLInputElement | null>(null),
    heading = useRef<HTMLHeadingElement | null>(null),
    opener = useRef<HTMLElement | null>(null);
  const clearing = action.busy === 'clear',
    preview = action.preview;
  useEffect(() => {
    if (preview) first.current?.focus();
  }, [preview]);
  return (
    <Dialog.Root
      open={action.open}
      onOpenChange={(open) => {
        if (!open) action.close();
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
              Clear stored session taint
            </Dialog.Title>
            <Dialog.Description>Entire recorded session · point-in-time change</Dialog.Description>
            <button
              className="dialog-close icon-button"
              aria-label="Close session taint preview"
              disabled={clearing}
              onClick={action.close}
            >
              <X size={19} />
            </button>
          </div>
          <div className="inventory-review-body">
            {action.error && (
              <p className="control-error" role="alert">
                {action.error}
              </p>
            )}
            {action.busy && (
              <p className="control-meta" role="status">
                <LoaderCircle size={16} className="spin" aria-hidden="true" />{' '}
                {clearing ? 'Clearing this exact stored taint…' : 'Preparing a read-only preview…'}
              </p>
            )}
            {preview && (
              <>
                <dl className="property-list">
                  <div>
                    <dt>Taint sources to clear</dt>
                    <dd>{preview.inspection.taint.sources}</dd>
                  </div>
                  <div>
                    <dt>Learned-origin records retained</dt>
                    <dd>{preview.inspection.provenance.records}</dd>
                  </div>
                </dl>
                <div className="mcp-acknowledgements">
                  <label>
                    <input
                      ref={first}
                      type="checkbox"
                      checked={action.ack.effects}
                      disabled={clearing}
                      onChange={(event) => action.acknowledge('effects', event.target.checked)}
                    />
                    <span>
                      Clear the stored taint for this entire session. I understand this weakens its
                      current taint restrictions.
                    </span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={action.ack.retention}
                      disabled={clearing}
                      onChange={(event) => action.acknowledge('retention', event.target.checked)}
                    />
                    <span>
                      I agree to retain the complete previous taint state, including private source
                      details, unencrypted for recovery.
                    </span>
                  </label>
                </div>
                <p className="control-meta">
                  Learned origins remain and can still restrict actions. New or in-flight results
                  may mark this session suspect again.
                </p>
                <details className="artifact-section">
                  <summary>Exact state & retention</summary>
                  <code className="inventory-digest">{preview.inspection.revisionSha256}</code>
                  <p className="control-meta">
                    Expires {new Date(preview.expiresAt).toLocaleTimeString('en-GB')} · single use
                  </p>
                  <p className="control-meta">
                    Private recovery is retained locally without automatic deletion. Policy, trust,
                    and finding history are unchanged. This does not verify host enforcement.
                  </p>
                </details>
                <div className="mcp-action-buttons">
                  <button
                    className="button primary"
                    disabled={
                      !!action.busy ||
                      action.needsRecheck ||
                      !action.ack.effects ||
                      !action.ack.retention
                    }
                    onClick={() => void action.apply()}
                  >
                    Clear stored session taint
                  </button>
                  <button className="button" disabled={clearing} onClick={action.close}>
                    Cancel preview
                  </button>
                </div>
              </>
            )}
            {!preview && !action.busy && (
              <button className="button" onClick={action.close}>
                Close
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
