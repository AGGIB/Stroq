'use client';
import Link from 'next/link';
import { ArrowRight, LoaderCircle, Square } from 'lucide-react';
import { Badge, Panel } from '@/components/platform-ui';
import {
  RUN_ERRORS,
  type ControlRun,
  type DoctorResult,
  type GuardTestResult,
  type PolicyCheckResult,
} from '@/lib/control';
import {
  PROTECTION_STEP_LABELS,
  type ProtectionCheckStep,
  type SavedProtectionResult,
  type WorkspaceProtectionResult,
} from '@/lib/protection-check';
import {
  protectionCheckOutcome,
  protectionStageOutcome,
  protectionStageSummary,
} from '@/lib/protection-check-presentation';
import { protectionRunHref } from '@/lib/protection-check-navigation';
import { workspaceReviewHref } from '@/lib/workspace-review-navigation';
import { ACTION_LABELS } from '@/lib/incident-comparison';
import {
  formatRunTime,
  InstallationResult,
  PolicyResult,
  ScenariosResult,
} from './protection-results';

function StageEvidence({
  step,
  workspaceId,
  matchesContext,
}: {
  step: ProtectionCheckStep;
  workspaceId: string | null;
  matchesContext: boolean;
}) {
  if (!step.result)
    return step.error ? (
      <p className="control-meta">{RUN_ERRORS[step.error] ?? RUN_ERRORS['engine-failed']}</p>
    ) : null;
  if (step.id === 'doctor')
    return (
      <InstallationResult
        result={step.result as DoctorResult}
        workspaceId={workspaceId}
        matchesCurrentRunContext={matchesContext}
      />
    );
  if (step.id === 'policy-check')
    return (
      <>
        <PolicyResult result={step.result as PolicyCheckResult} />
        {matchesContext && (
          <Link className="inline-link" href="/policies/">
            Review policy <ArrowRight size={14} />
          </Link>
        )}
      </>
    );
  if (step.id === 'guard-test') return <ScenariosResult result={step.result as GuardTestResult} />;
  if (step.id === 'saved-policy-checks') {
    const result = step.result as SavedProtectionResult;
    return (
      <>
        <p className="control-meta">
          {result.total === 0
            ? 'No saved expectations in this capture.'
            : `${result.passed} matched · ${result.failed} did not match`}
        </p>
        {result.results.length > 0 && (
          <div
            className="table-wrap"
            role="region"
            aria-label="Recorded saved policy expectations"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Action group</th>
                  <th>Context</th>
                  <th>Expected</th>
                  <th>Recorded</th>
                </tr>
              </thead>
              <tbody>
                {result.results.flatMap((row, index) =>
                  row.scenarios.map((s) => (
                    <tr key={`${row.caseId}-${s.taint}`}>
                      <td>
                        {result.cases[index]?.classes
                          .map((value) => ACTION_LABELS[value])
                          .join(' · ')}
                      </td>
                      <td>{s.taint === 'none' ? 'Clean' : 'Suspect'}</td>
                      <td>{s.expected}</td>
                      <td>{s.actual}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        {matchesContext && result.workspaceId === workspaceId && (
          <Link className="inline-link" href="/policies/checks/">
            Review saved checks <ArrowRight size={14} />
          </Link>
        )}
      </>
    );
  }
  const result = step.result as WorkspaceProtectionResult;
  return (
    <>
      <p className="control-meta">
        {result.sources} sources, {result.entries} entries, {result.errors} errors,{' '}
        {result.warnings} warnings
      </p>
      {(!result.complete || result.coverage.gaps > 0) && (
        <p className="control-meta">Partial capture · {result.coverage.gaps} coverage gaps</p>
      )}
      {workspaceId === result.workspaceId && (
        <Link className="inline-link" href={workspaceReviewHref(result.runId, result.workspaceId)}>
          Inspect captured workspace <ArrowRight size={14} />
        </Link>
      )}
    </>
  );
}
export function ProtectionCheckReport({
  run,
  workspaceId,
  matchesContext,
  owned = false,
  canCancel,
  cancelling,
  onCancel,
}: {
  run: ControlRun;
  workspaceId: string | null;
  matchesContext: boolean;
  owned?: boolean;
  canCancel: boolean;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const outcome =
    run.status === 'running' && !owned
      ? { label: 'State unverified', tone: 'muted' as const }
      : protectionCheckOutcome(run);
  const completed = run.progress?.steps.filter((s) => s.status === 'completed').length ?? 0;
  return (
    <section id="protection-check" tabIndex={-1} aria-label="Recorded protection check">
      <Panel
        title="Protection check"
        actions={
          <>
            <Badge tone={matchesContext ? outcome.tone : 'muted'}>
              {matchesContext ? outcome.label : 'Historical result'}
            </Badge>
            {canCancel && run.status === 'running' && (
              <button className="button small" disabled={cancelling} onClick={onCancel}>
                {cancelling ? (
                  <LoaderCircle size={15} className="spin" aria-hidden="true" />
                ) : (
                  <Square size={15} aria-hidden="true" />
                )}
                Cancel check
              </button>
            )}
          </>
        }
      >
        <div className="panel-body">
          <div className="control-meta" role="status" aria-live="polite">
            <span>{completed} of 5 checks recorded</span>
            <span>Local checks · no provider requests</span>
            <time dateTime={run.finishedAt ?? run.startedAt}>
              {formatRunTime(run.finishedAt ?? run.startedAt)} UTC
            </time>
          </div>
          {run.status === 'running' && !owned && (
            <p className="control-meta">Unfinished recorded attempt · active owner unverified.</p>
          )}
          {!matchesContext && (
            <p className="control-meta">
              This recorded attempt does not establish the current configuration.
            </p>
          )}
          {run.error && (
            <p className="control-error" role="status">
              {RUN_ERRORS[run.error] ?? RUN_ERRORS['engine-failed']}
            </p>
          )}
          <div className="protection-checks protection-check-stages">
            {run.progress?.steps.map((step) => {
              const state =
                !owned && run.status === 'running' && ['running', 'queued'].includes(step.status)
                  ? {
                      label: step.status === 'running' ? 'State unverified' : 'Not started',
                      tone: 'muted' as const,
                    }
                  : protectionStageOutcome(step);
              const summary = protectionStageSummary(step);
              const inheritedReason =
                step.status === 'skipped' && step.startedAt === null && step.error === run.error;
              const visibleReason =
                step.error && !inheritedReason && step.error !== run.error
                  ? RUN_ERRORS[step.error]
                  : null;
              const hasEvidence = step.result || (step.error && !inheritedReason);
              return (
                <section
                  className="protection-result protection-check-stage"
                  id={`protection-check-${step.id}`}
                  key={step.id}
                  tabIndex={-1}
                  aria-label={PROTECTION_STEP_LABELS[step.id]}
                >
                  <div className="panel-heading">
                    <h3>{PROTECTION_STEP_LABELS[step.id]}</h3>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>
                  {(summary || visibleReason) && (
                    <p className="control-meta">{summary ?? visibleReason}</p>
                  )}
                  {step.status === 'running' && owned && (
                    <p className="control-meta" role="status">
                      <LoaderCircle size={16} className="spin" aria-hidden="true" />
                      Checking…
                    </p>
                  )}
                  {hasEvidence ? (
                    <details className="control-check-details">
                      <summary>Evidence & scope</summary>
                      <div className="panel-body">
                        <StageEvidence
                          step={step}
                          workspaceId={workspaceId}
                          matchesContext={matchesContext}
                        />
                        <p className="control-meta">
                          {step.id === 'doctor' || step.id === 'policy-check'
                            ? 'Recorded configuration'
                            : step.id === 'workspace-review'
                              ? 'Static capture'
                              : 'Policy simulation'}{' '}
                          · host enforcement not tested
                        </p>
                        {workspaceId && (
                          <Link
                            className="inline-link"
                            href={protectionRunHref(run.id, workspaceId, step.id)}
                          >
                            Link to this stage <ArrowRight size={14} />
                          </Link>
                        )}
                      </div>
                    </details>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      </Panel>
    </section>
  );
}
