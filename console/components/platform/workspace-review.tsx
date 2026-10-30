'use client';
import { useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, FolderSearch, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { Badge, EmptyState, ExportButton, PageHeading, Panel } from '@/components/platform-ui';
import { workspaceReviewHref, workspaceReviewSelection } from '@/lib/workspace-review-navigation';
import { WORKSPACE_REVIEW_ERROR_MESSAGES } from '@/lib/workspace-review-errors';
import { WorkspaceReviewReport } from './workspace-review-report';
import { useWorkspaceReview } from './use-workspace-review';
import { WorkspaceMonitor } from './workspace-monitor';
import { useWorkspaceTaskControls } from './use-workspace-task-controls';
import {
  WorkspaceTaskControlsDialog,
  WorkspaceTaskOutcome,
  WorkspaceTaskRecovery,
} from './workspace-task-controls';
import { workspaceTaskRecordSelection } from '@/lib/workspace-task-controls-binding';

export function WorkspaceReviewPage() {
  const params = useSearchParams(),
    router = useRouter();
  const selection = workspaceReviewSelection(params);
  const read = useWorkspaceReview(selection),
    { state, run } = read;
  const taskSelection = workspaceTaskRecordSelection(params);
  const tasks = useWorkspaceTaskControls({
    workspaceId: read.workspaceId,
    enabled: read.allowed,
    run,
    selectionKey: JSON.stringify(taskSelection),
  });
  const taskTrigger = useRef<HTMLButtonElement | null>(null);
  const recorded =
    run?.result !== undefined &&
    state?.baseline.status === 'available' &&
    state.baseline.capture?.captureSha256 === run.result.capture.captureSha256;
  const baselineChanged =
    run?.result !== undefined &&
    state !== null &&
    state.baseline.revision !== run.result.baseline.revision &&
    !recorded;
  const start = async () => {
    const result = await read.check();
    const href = result ? read.getRunHref(result) : null;
    if (href) router.push(href);
  };
  return (
    <div className="page-stack">
      <PageHeading
        title="Workspace review"
        actions={
          <>
            <Link className="button" href="/protection/">
              <ArrowLeft size={16} aria-hidden="true" />
              Protection
            </Link>
            <button
              className="icon-button"
              aria-label="Refresh saved workspace checks"
              disabled={!read.allowed || !!read.busy}
              onClick={() => void read.refresh()}
            >
              <RefreshCw
                size={17}
                className={read.busy === 'load' ? 'spin' : undefined}
                aria-hidden="true"
              />
            </button>
            <button
              className="button primary"
              disabled={
                !state ||
                !state.engine.available ||
                state.history.status !== 'ready' ||
                !!read.running ||
                !!read.busy ||
                read.needsRecheck
              }
              onClick={() => void start()}
            >
              <FolderSearch size={17} aria-hidden="true" />
              Check workspace
            </button>
          </>
        }
      />
      {!read.allowed ? (
        <Panel>
          <EmptyState
            title={
              selection.requested
                ? 'This report context is unavailable'
                : 'Connect your local engine'
            }
            description={
              selection.invalid
                ? 'The report link is incomplete or invalid.'
                : selection.requested
                  ? 'This report belongs to a different selected workspace.'
                  : 'Open the private server link to establish the selected workspace.'
            }
          />
          <Link
            className="button"
            href={selection.requested ? workspaceReviewHref() : '/settings/'}
          >
            {selection.requested ? 'Open current workspace checks' : 'Connection settings'}
          </Link>
        </Panel>
      ) : (
        <>
          <div className="protection-status">
            <div className="protection-status-main">
              <FolderSearch size={20} aria-hidden="true" />
              <strong>{read.workspaceLabel ?? 'Selected workspace'}</strong>
              <span className="muted">No execution or provider requests</span>
            </div>
          </div>
          <WorkspaceMonitor />
          <WorkspaceTaskOutcome controls={tasks} />
          <WorkspaceTaskControlsDialog
            controls={tasks}
            onReturnFocus={() => taskTrigger.current?.focus()}
          />
          {read.error && (
            <p className="control-error" role="alert">
              {read.error}
            </p>
          )}
          {read.needsRecheck && (
            <p className="control-meta" role="status">
              Completion is unknown.{' '}
              <button
                className="button small"
                disabled={!!read.busy}
                onClick={() => void read.refresh()}
              >
                Recheck saved reports
              </button>
            </p>
          )}
          {read.pollStopped && (
            <p className="control-meta" role="status">
              Live updates paused after repeated read failures. Refresh saved checks to retry.
            </p>
          )}
          {state?.history.status === 'error' && (
            <p className="control-error" role="alert">
              Saved history could not be verified. No empty result is available.
            </p>
          )}
          {state?.baseline.status === 'invalid' && (
            <p className="control-error" role="alert">
              The reviewed baseline could not be verified.
            </p>
          )}
          {state && !state.engine.available && (
            <p className="control-meta" role="status">
              Local analysis runtime unavailable. <Link href="/settings/">Connection settings</Link>
            </p>
          )}
          {!state ? (
            <Panel>
              <div className="control-empty" role="status">
                {read.busy === 'load' ? (
                  <>
                    <LoaderCircle size={26} className="spin" aria-hidden="true" />
                    <p>Reading saved workspace checks…</p>
                  </>
                ) : (
                  <p>Saved workspace checks are unavailable. Refresh to retry.</p>
                )}
              </div>
            </Panel>
          ) : !run ? (
            <Panel>
              <EmptyState
                title={
                  selection.runId
                    ? 'The selected report is not in saved history'
                    : 'Check before opening a workspace'
                }
                description={
                  selection.runId
                    ? 'Reports may be evicted from bounded history. A newer result has not been substituted.'
                    : 'Capture startup actions and agent instructions, then review changes on your next check.'
                }
              />
              {selection.runId && (
                <Link href={workspaceReviewHref()} className="button">
                  Open current workspace checks
                </Link>
              )}
            </Panel>
          ) : (
            <Panel
              title="Captured workspace"
              actions={
                <Badge tone={run.status === 'failed' ? 'orange' : 'muted'}>
                  {run.status === 'completed'
                    ? 'Recorded report'
                    : run.status === 'running'
                      ? 'Checking'
                      : run.status === 'cancelled'
                        ? 'Cancelled'
                        : 'Check failed'}
                </Badge>
              }
            >
              <div className="panel-body">
                {run.status === 'running' ? (
                  <div className="control-empty">
                    <LoaderCircle className="spin" size={28} aria-hidden="true" />
                    <p role="status">Reading workspace configuration…</p>
                    <button
                      className="button"
                      disabled={!!read.busy || read.needsRecheck}
                      onClick={() => void read.cancel()}
                    >
                      <X size={16} aria-hidden="true" />
                      Cancel check
                    </button>
                  </div>
                ) : run.result ? (
                  <>
                    <WorkspaceReviewReport
                      result={run.result}
                      taskControlsDisabled={
                        !tasks.canPrepare || !!read.busy || !!read.running || read.needsRecheck
                      }
                      onMakeTasksManual={(source, trigger) => {
                        taskTrigger.current = trigger ?? null;
                        void tasks.prepare(source);
                      }}
                    />
                    <div className="workspace-review-actions">
                      <ExportButton
                        data={() => read.getReport()}
                        filename="stroq-workspace-review.json"
                        label="Export capture"
                      />
                      {(recorded || read.receipt) && (
                        <span className="control-meta" role="status">
                          <Check size={16} aria-hidden="true" />
                          Review recorded
                          {read.receipt
                            ? ` · ${new Date(read.receipt.reviewedAt).toLocaleString()}`
                            : ''}
                        </span>
                      )}
                    </div>
                    {baselineChanged && (
                      <p className="control-meta">
                        The reviewed baseline changed after this report. Check the workspace again
                        before recording another review.
                      </p>
                    )}
                    {!recorded && !read.receipt && read.canReview && (
                      <>
                        <label className="policy-ack">
                          <input
                            type="checkbox"
                            checked={read.acknowledged}
                            disabled={!!read.busy || read.needsRecheck}
                            onChange={(event) => read.acknowledge(event.target.checked)}
                          />
                          <span>
                            Record this review only. This does not trust the workspace or enable
                            execution.
                          </span>
                        </label>
                        <button
                          className="button"
                          disabled={!read.acknowledged || !!read.busy || read.needsRecheck}
                          onClick={() => void read.review()}
                        >
                          {read.busy === 'review' ? (
                            <LoaderCircle className="spin" size={16} aria-hidden="true" />
                          ) : (
                            <Check size={16} aria-hidden="true" />
                          )}
                          Review this version
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <p className="control-meta" role="status">
                    {run.error
                      ? WORKSPACE_REVIEW_ERROR_MESSAGES[run.error]
                      : 'No completed capture is available.'}
                  </p>
                )}
              </div>
            </Panel>
          )}
          {state && state.runs.length > 0 && (
            <Panel title="Saved checks">
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Captured</th>
                      <th>Result</th>
                      <th>Signals</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.runs
                      .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
                      .map((item) => (
                        <tr key={item.id}>
                          <td>{new Date(item.startedAt).toLocaleString()}</td>
                          <td>
                            {item.status === 'completed'
                              ? item.result!.capture.complete
                                ? 'Complete capture'
                                : 'Partial capture'
                              : item.status}
                          </td>
                          <td>{item.result?.capture.entries.length ?? '—'}</td>
                          <td>
                            <Link
                              className="button small"
                              aria-current={item.id === run?.id ? 'page' : undefined}
                              href={workspaceReviewHref(item.id, state.workspaceId)}
                            >
                              View capture
                            </Link>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}
          <WorkspaceTaskRecovery controls={tasks} selection={taskSelection} />
        </>
      )}
    </div>
  );
}
