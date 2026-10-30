'use client';
import { Dialog } from 'radix-ui';
import { useEffect, useRef } from 'react';
import { ArrowRight, Check, FileCheck2, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { Badge, ExportButton, Panel } from '@/components/platform-ui';
import type { Incident, JournalVerification } from '@/lib/incidents';
import type { IncidentComparison } from '@/lib/incident-comparison';
import { IncidentComparisonPanel } from './incident-comparison';
import { IncidentLink } from './incident-link';
import { IncidentTask } from './incident-task';
import { useIncidentTask } from './use-incident-task';
import { useTaskAccess } from './use-task-access';
import { TaskAccessDialog, TaskAccessTrigger } from './task-access';
import { useSessionTaint } from './use-session-taint';
import { SessionTaintDialog, SessionTaintPanel } from './session-taint';
import { IncidentAssessmentDialog, IncidentAssessmentLine } from './incident-assessments';
import type { IncidentAssessmentsAction } from './use-incident-assessments';
import { incidentAssessmentExport } from '@/lib/incident-assessment-export';
import { useIncidentRecordedEvidence } from './use-incident-recorded-evidence';
import { IncidentRecordedEvidencePanel } from './incident-recorded-evidence';

export function IncidentDetailDialog({
  selected,
  assessments,
  incidents,
  busy,
  reviewing,
  error,
  onSelect,
  onReview,
  comparison,
  comparing,
  href,
  onCompare,
  onReturnFocus,
}: {
  selected: Incident | null;
  assessments: IncidentAssessmentsAction;
  incidents: readonly Incident[];
  busy: boolean;
  reviewing: boolean;
  error: string | null;
  onSelect: (incident: Incident | null) => void;
  onReview: (incident: Incident) => void;
  comparison: IncidentComparison | null;
  comparing: boolean;
  href: string;
  onCompare: (incident: Incident) => void;
  onReturnFocus: () => void;
}) {
  const taskRelation = useIncidentTask(selected);
  const taskAccess = useTaskAccess(selected);
  const sessionTaint = useSessionTaint(selected);
  const recordedEvidence = useIncidentRecordedEvidence(selected);
  const clearingTaint = sessionTaint.busy === 'clear';
  const recordingAssessment = assessments.busy === 'apply';
  const locked = busy || clearingTaint || recordingAssessment;
  const content = useRef<HTMLDivElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const id = selected?.id ?? null;
    if (id && previous.current && previous.current !== id) {
      if (content.current) content.current.scrollTop = 0;
      heading.current?.focus({ preventScroll: true });
    }
    previous.current = id;
  }, [selected?.id]);
  return (
    <>
      <TaskAccessDialog action={taskAccess} />
      <SessionTaintDialog action={sessionTaint} onReturnFocus={() => heading.current?.focus()} />
      <IncidentAssessmentDialog
        action={assessments}
        disabled={busy || clearingTaint}
        onReturnFocus={() => heading.current?.focus()}
      />
      <Dialog.Root
        open={selected !== null}
        onOpenChange={(value) => {
          if (!value && !reviewing && !clearingTaint && !recordingAssessment) onSelect(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            ref={content}
            className="dialog-content investigation-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              onReturnFocus();
            }}
          >
            <div className="dialog-header">
              <Dialog.Title ref={heading} tabIndex={-1}>
                {selected?.title ?? 'Investigation'}
              </Dialog.Title>
              <Dialog.Description>
                Recorded evidence · host outcome is unverified
              </Dialog.Description>
              <Dialog.Close
                className="dialog-close icon-button"
                aria-label="Close investigation"
                disabled={reviewing || clearingTaint || recordingAssessment}
              >
                <X size={18} />
              </Dialog.Close>
            </div>
            {selected && (
              <>
                <Badge tone={selected.status === 'open' ? 'orange' : 'muted'}>
                  {selected.status === 'open' ? 'Needs review' : 'Reviewed'}
                </Badge>
                <IncidentAssessmentLine action={assessments} disabled={locked} />
                <div className="incident-detail-tools">
                  <IncidentLink href={href} />
                  {selected.kind !== 'content-flag' && (
                    <TaskAccessTrigger action={taskAccess} disabled={locked} />
                  )}
                  <ExportButton
                    data={() => ({
                      schema: 'stroq-investigation-export/4',
                      source: 'local',
                      exportedAt: new Date().toISOString(),
                      incident: selected,
                      comparison,
                      taskRelation: taskRelation.getReport(),
                      recordedEvidence: recordedEvidence.getReport(),
                      operatorAssessments: incidentAssessmentExport(
                        assessments.state,
                        assessments.pending,
                        [selected],
                      ),
                    })}
                    filename={`stroq-investigation-${selected.sequence}.json`}
                    label="Export finding"
                  />
                </div>
                <IncidentRecordedEvidencePanel action={recordedEvidence} disabled={locked} />
                <dl className="property-list">
                  <div>
                    <dt>Journal sequence</dt>
                    <dd>{selected.sequence}</dd>
                  </div>
                  <div>
                    <dt>Recorded</dt>
                    <dd>{new Date(selected.recordedAt).toLocaleString('en-GB')}</dd>
                  </div>
                  <div>
                    <dt>Context</dt>
                    <dd>{selected.categories.join(', ')}</dd>
                  </div>
                  <div>
                    <dt>Secret references</dt>
                    <dd>{selected.secretReferences}</dd>
                  </div>
                  {selected.reviewedAt && (
                    <div>
                      <dt>Manually reviewed</dt>
                      <dd>{new Date(selected.reviewedAt).toLocaleString('en-GB')}</dd>
                    </div>
                  )}
                </dl>
                <IncidentTask action={taskRelation} disabled={locked} />
                <SessionTaintPanel action={sessionTaint} disabled={locked} />
                {selected.kind !== 'content-flag' && (
                  <IncidentComparisonPanel
                    report={comparison}
                    busy={locked}
                    comparing={comparing}
                    onCompare={() => onCompare(selected)}
                  />
                )}
                {selected.relatedIds.length > 0 && (
                  <div className="investigation-related">
                    <h3>Preceding content findings</h3>
                    <p className="control-meta">
                      Same recorded session; relation does not establish causation.
                    </p>
                    {selected.relatedIds.map((id) => {
                      const item = incidents.find((i) => i.id === id);
                      return item ? (
                        <button
                          className="inline-link"
                          key={id}
                          disabled={locked}
                          onClick={() => {
                            if (!locked) onSelect(item);
                          }}
                        >
                          Journal #{item.sequence} · {item.title}
                          <ArrowRight size={14} />
                        </button>
                      ) : null;
                    })}
                  </div>
                )}
                <details className="setup-next">
                  <summary>Evidence fingerprint</summary>
                  <code className="inventory-digest">{selected.evidenceSha}</code>
                </details>
                <p className="muted">
                  Review acknowledges this exact recorded evidence. Verify remediation separately.
                </p>
                {error && (
                  <p className="control-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="dialog-footer">
                  <button
                    className="button primary"
                    disabled={locked}
                    onClick={() => onReview(selected)}
                  >
                    {reviewing ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : selected.status === 'open' ? (
                      <Check size={16} />
                    ) : (
                      <RotateCcw size={16} />
                    )}{' '}
                    {selected.status === 'open' ? 'Mark reviewed' : 'Reopen review'}
                  </button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

export function CapturedJournalPanel({
  verification,
  disabled,
  verifying,
  onVerify,
}: {
  verification: JournalVerification | null;
  disabled: boolean;
  verifying: boolean;
  onVerify: () => void;
}) {
  return (
    <Panel
      title="Captured journal"
      actions={
        <button className="button" disabled={disabled} onClick={onVerify}>
          {verifying ? <LoaderCircle className="spin" size={16} /> : <FileCheck2 size={16} />}
          Verify journal
        </button>
      }
    >
      <div className="panel-body investigation-journal">
        {verification ? (
          <>
            <div className="protection-status-main">
              <Badge
                tone={
                  verification.status === 'consistent'
                    ? 'green'
                    : verification.status === 'broken'
                      ? 'red'
                      : 'orange'
                }
              >
                {verification.status}
              </Badge>
              <span className="control-meta">
                Captured {new Date(verification.verifiedAt).toLocaleString('en-GB')}
              </span>
            </div>
            <dl className="property-list">
              <div>
                <dt>Journal entries</dt>
                <dd>{verification.count ?? 'Unavailable'}</dd>
              </div>
              {verification.brokenAt !== null && (
                <div>
                  <dt>First broken entry</dt>
                  <dd>{verification.brokenAt}</dd>
                </div>
              )}
            </dl>
            {verification.journalSha && (
              <code className="inventory-digest">{verification.journalSha}</code>
            )}
            {verification.limitations.map((limit) => (
              <p className="control-meta" key={limit}>
                {limit}
              </p>
            ))}
          </>
        ) : (
          <p className="muted">
            Verify a complete captured journal with Stroq’s hash-chain verifier. Consistency alone
            does not establish authenticity or host blocking.
          </p>
        )}
      </div>
    </Panel>
  );
}
