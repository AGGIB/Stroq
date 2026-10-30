'use client';
import { useRef } from 'react';
import { Dialog } from 'radix-ui';
import { LoaderCircle, X } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import {
  INCIDENT_ASSESSMENT_LABELS,
  INCIDENT_ASSESSMENT_REASONS,
  INCIDENT_ASSESSMENT_REASON_DECISIONS,
  INCIDENT_ASSESSMENT_ERROR_MESSAGES,
  type IncidentAssessmentDecision,
  type IncidentAssessmentReason,
  type IncidentAssessmentRecord,
} from '@/lib/incident-assessments';
import type { IncidentAssessmentsAction } from './use-incident-assessments';

export function IncidentAssessmentBadge({
  record,
  unavailable = false,
  pending = false,
}: {
  record: IncidentAssessmentRecord | null;
  unavailable?: boolean;
  pending?: boolean;
}) {
  return (
    <Badge tone={unavailable || pending ? 'orange' : 'muted'}>
      {pending
        ? 'Save unconfirmed'
        : unavailable
          ? 'Assessment unavailable'
          : record
            ? INCIDENT_ASSESSMENT_LABELS[record.assessment]
            : 'Not assessed'}
    </Badge>
  );
}
export function IncidentAssessmentLine({
  action,
  disabled = false,
}: {
  action: IncidentAssessmentsAction;
  disabled?: boolean;
}) {
  return (
    <div className="incident-assessment-line incident-detail-tools" aria-label="Finding assessment">
      <span className="control-meta">Assessment</span>
      <IncidentAssessmentBadge
        record={action.latest}
        unavailable={!action.available}
        pending={action.completionUnknown}
      />
      <button
        className="button subtle small"
        aria-label={action.latest ? 'Change finding assessment' : 'Assess finding'}
        disabled={disabled || !!action.busy || !action.binding}
        onClick={action.show}
      >
        {action.latest ? 'Change' : 'Assess'}
      </button>
      {action.needsRecheck && !action.completionUnknown && (
        <span className="control-meta">Pending save</span>
      )}
    </div>
  );
}
export function IncidentAssessmentDialog({
  action,
  disabled = false,
  onReturnFocus,
}: {
  action: IncidentAssessmentsAction;
  disabled?: boolean;
  onReturnFocus?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null),
    opener = useRef<HTMLElement | null>(null);
  const applying = action.busy === 'apply',
    locked = disabled || !!action.busy;
  const stateError = action.state?.error
    ? INCIDENT_ASSESSMENT_ERROR_MESSAGES[action.state.error]
    : null;
  // Presentation only: the pending panel already explains this generic notice.
  const repeatedPendingNotice =
    action.needsRecheck &&
    action.error === 'Save unconfirmed. Recheck this assessment before saving again.';
  const message = (repeatedPendingNotice ? null : action.error) ?? stateError;
  const canReopen = !!action.latest && action.latest.assessment !== 'reopened';
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
          onEscapeKeyDown={(event) => {
            if (applying) event.preventDefault();
          }}
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
              Assess finding
            </Dialog.Title>
            <Dialog.Description>
              Journal #{action.binding?.sequence ?? '—'} · This recorded finding
            </Dialog.Description>
            <button
              className="dialog-close icon-button"
              aria-label="Close finding assessment"
              disabled={applying}
              onClick={action.close}
            >
              <X size={19} />
            </button>
          </div>
          <div className="inventory-review-body">
            {action.busy && (
              <p className="control-meta" role="status">
                <LoaderCircle size={16} className="spin" aria-hidden="true" />{' '}
                {action.busy === 'preview'
                  ? 'Preparing assessment…'
                  : applying
                    ? 'Saving assessment…'
                    : action.busy === 'recheck'
                      ? 'Rechecking assessment…'
                      : 'Reading assessment history…'}
              </p>
            )}
            {message && (
              <p className="control-error" role="alert">
                {message}
              </p>
            )}
            {action.needsRecheck && (
              <div className="control-error" role="status">
                <p>Save unconfirmed. Recheck before saving again.</p>
                {action.pending.map((write) => (
                  <button
                    className="button small"
                    key={write.preview.recordId}
                    disabled={locked}
                    onClick={() => void action.recheck(write.preview.recordId)}
                  >
                    Recheck save · Journal #{write.preview.incident.sequence}
                  </button>
                ))}
              </div>
            )}
            {action.receipt && (
              <p className="control-meta" role="status">
                {action.receipt.status === 'not-present'
                  ? 'No matching record at this check.'
                  : 'Assessment record confirmed.'}{' '}
                No action was replayed.
              </p>
            )}
            {!action.available && action.busy !== 'load' && (
              <div>
                <p className="control-meta">Assessment unavailable.</p>
                <button
                  className="button small"
                  disabled={locked}
                  onClick={() => void action.refresh()}
                >
                  Refresh assessment history
                </button>
              </div>
            )}
            {action.available && (
              <>
                <div className="inventory-signal-fields">
                  <label>
                    <span>Assessment</span>
                    <select
                      className="select-field"
                      aria-label="Assessment"
                      value={action.choice.assessment ?? ''}
                      disabled={locked}
                      onChange={(event) =>
                        action.setChoice(event.target.value as IncidentAssessmentDecision, null)
                      }
                    >
                      <option value="" disabled>
                        Choose assessment
                      </option>
                      {(Object.keys(INCIDENT_ASSESSMENT_LABELS) as IncidentAssessmentDecision[])
                        .filter(
                          (value) =>
                            value !== 'reopened' ||
                            canReopen ||
                            action.choice.assessment === 'reopened',
                        )
                        .map((value) => (
                          <option
                            value={value}
                            key={value}
                            disabled={value === 'reopened' && !canReopen}
                          >
                            {INCIDENT_ASSESSMENT_LABELS[value]}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <span>Reason</span>
                    <select
                      className="select-field"
                      aria-label="Assessment reason"
                      value={action.choice.reason ?? ''}
                      disabled={locked || !action.choice.assessment}
                      onChange={(event) =>
                        action.setChoice(
                          action.choice.assessment,
                          event.target.value as IncidentAssessmentReason,
                        )
                      }
                    >
                      <option value="" disabled>
                        Choose reason
                      </option>
                      {(Object.keys(INCIDENT_ASSESSMENT_REASONS) as IncidentAssessmentReason[])
                        .filter(
                          (value) =>
                            INCIDENT_ASSESSMENT_REASON_DECISIONS[value] ===
                            action.choice.assessment,
                        )
                        .map((value) => (
                          <option value={value} key={value}>
                            {INCIDENT_ASSESSMENT_REASONS[value]}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <p className="control-meta">
                  Assessment only. Policy, session taint and recorded evidence stay unchanged.
                </p>
                <div className="mcp-action-buttons">
                  <button
                    className="button primary"
                    disabled={locked || !action.canSave}
                    onClick={() => void action.save()}
                  >
                    Save assessment
                  </button>
                  <button className="button" disabled={applying} onClick={action.close}>
                    Cancel
                  </button>
                </div>
                {action.history.length > 0 && (
                  <details className="setup-next">
                    <summary>Assessment history · {action.history.length}</summary>
                    <ol className="incident-assessment-history">
                      {action.history.toReversed().map((record) => (
                        <li key={record.id}>
                          <strong>{INCIDENT_ASSESSMENT_LABELS[record.assessment]}</strong>
                          <p className="control-meta">
                            {INCIDENT_ASSESSMENT_REASONS[record.reason]} ·{' '}
                            <time dateTime={record.assessedAt}>
                              {new Date(record.assessedAt).toLocaleString('en-GB')}
                            </time>
                          </p>
                        </li>
                      ))}
                    </ol>
                    <p className="control-meta">
                      Private local assessments · retained without automatic deletion
                    </p>
                    <button
                      className="button small"
                      disabled={locked}
                      onClick={() => void action.refresh()}
                    >
                      Refresh assessment history
                    </button>
                  </details>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
