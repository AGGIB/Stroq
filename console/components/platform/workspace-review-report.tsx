'use client';
import { Badge } from '@/components/platform-ui';
import { WORKSPACE_REVIEW_LABELS } from '@/lib/workspace-review-labels';
import { WORKSPACE_TASK_SOURCE_ID } from '@/lib/workspace-task-controls';
import {
  WORKSPACE_REVIEW_LIMITATIONS,
  type WorkspaceReviewCapture,
  type WorkspaceReviewEntry,
  type WorkspaceReviewResult,
  type WorkspaceReviewSource,
} from '@/lib/workspace-review';

const GAP_LABELS = {
  unreadable: 'Source could not be read',
  'invalid-utf8': 'Source encoding could not be read',
  'not-regular': 'Source is not a regular file',
  'too-large': 'Source exceeds the reading limit',
  limit: 'Capture limit reached',
  'outside-root': 'Source resolves outside the permitted root',
  'source-changed': 'Source changed during capture',
  unparsed: 'Source could not be parsed',
  'git-metadata-unverified': 'Git metadata could not be verified',
  'enclosing-repository':
    'Workspace is inside a Git repository whose configuration and hooks were not read',
  'nested-repository': 'Nested Git repository whose configuration and hooks were not read',
  'projection-limit': 'Report projection limit reached',
} as const;
const STAGES = [
  ['pre-trust', 'Before trust'],
  ['on-open', 'On open'],
  ['instructions', 'Instructions'],
] as const;
function sourceLabel(capture: WorkspaceReviewCapture, entry: WorkspaceReviewEntry) {
  return capture.sources.find((source) => source.id === entry.sourceId)?.label ?? 'Captured source';
}
function sourceKindChange(result: WorkspaceReviewResult, sourceId: string) {
  const before = result.baseline.capture?.sources.find((source) => source.id === sourceId);
  const after = result.capture.sources.find((source) => source.id === sourceId);
  return before && after && before.kind !== after.kind ? ` · ${before.kind} → ${after.kind}` : '';
}
function SignalRows({
  entries,
  capture,
  onMakeTasksManual,
  taskControlsDisabled = false,
}: {
  entries: WorkspaceReviewEntry[];
  capture: WorkspaceReviewCapture;
  onMakeTasksManual?: (source: WorkspaceReviewSource, trigger?: HTMLButtonElement) => void;
  taskControlsDisabled?: boolean;
}) {
  return (
    <div className="workspace-review-signals">
      {entries.map((entry, index) => (
        <div className="workspace-review-signal" key={entry.id}>
          <div>
            <strong>{WORKSPACE_REVIEW_LABELS[entry.kind]}</strong>
            <p className="control-meta">
              <code>{sourceLabel(capture, entry)}</code>
              {entry.line !== null ? ` · line ${entry.line}` : ''}
              {entry.count > 1 ? ` · ${entry.count} occurrences` : ''}
            </p>
            {onMakeTasksManual &&
              entry.kind === 'editor-autorun-task' &&
              entries.findIndex(
                (value) => value.sourceId === entry.sourceId && value.kind === entry.kind,
              ) === index &&
              capture.sources.some(
                (source) =>
                  source.id === entry.sourceId &&
                  source.id === WORKSPACE_TASK_SOURCE_ID &&
                  source.label === '.vscode/tasks.json' &&
                  !source.labelHidden &&
                  source.kind === 'file' &&
                  source.role === 'workspace',
              ) && (
                <button
                  className="button small"
                  disabled={taskControlsDisabled}
                  onClick={(event) =>
                    onMakeTasksManual(
                      capture.sources.find((source) => source.id === entry.sourceId)!,
                      event.currentTarget,
                    )
                  }
                >
                  Make tasks manual…
                </button>
              )}
          </div>
          <Badge
            tone={
              entry.severity === 'error' ? 'red' : entry.severity === 'warning' ? 'orange' : 'muted'
            }
          >
            {entry.severity === 'error'
              ? 'Attention'
              : entry.severity === 'warning'
                ? 'Review'
                : 'Recorded'}
          </Badge>
        </div>
      ))}
    </div>
  );
}
export function WorkspaceReviewReport({
  result,
  onMakeTasksManual,
  taskControlsDisabled,
}: {
  result: WorkspaceReviewResult;
  onMakeTasksManual?: (source: WorkspaceReviewSource, trigger?: HTMLButtonElement) => void;
  taskControlsDisabled?: boolean;
}) {
  const { capture, comparison, baseline } = result;
  return (
    <>
      <div className="workspace-review-summary">
        <div>
          <strong>{capture.entries.length}</strong>
          <span className="muted"> recorded signals · {capture.sources.length} sources</span>
        </div>
        <Badge tone={capture.complete ? 'muted' : 'orange'}>
          {capture.complete ? 'Complete capture' : 'Partial capture'}
        </Badge>
      </div>
      <p className="control-meta">
        Captured {new Date(capture.capturedAt).toLocaleString()} · Static reading; workspace trust
        and execution are not established.
      </p>
      <section className="workspace-review-comparison" aria-label="Comparison at capture time">
        <h3>Comparison at capture time</h3>
        {comparison.status === 'comparable' ? (
          <>
            <div className="incident-class-list">
              <Badge tone={comparison.sources.length ? 'orange' : 'muted'}>
                {comparison.sources.length} sources changed
              </Badge>
              <Badge tone={comparison.entries.added.length ? 'orange' : 'muted'}>
                {comparison.entries.added.length} signals added
              </Badge>
              <Badge>{comparison.entries.removed.length} signals removed</Badge>
              <Badge>{comparison.entries.unchanged} unchanged</Badge>
            </div>
            {comparison.sources.length > 0 && (
              <details className="live-details">
                <summary>Source changes</summary>
                <div className="table-scroll">
                  <table className="data-table workspace-review-sources">
                    <thead>
                      <tr>
                        <th>Source</th>
                        <th>Change</th>
                        <th>Fingerprint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparison.sources.map((source) => (
                        <tr key={source.id}>
                          <td>
                            <code>{source.label}</code>
                            {source.labelHidden && (
                              <span className="control-meta"> · label withheld</span>
                            )}
                          </td>
                          <td>
                            {source.state === 'changed'
                              ? 'Changed'
                              : source.state === 'added'
                                ? 'Added'
                                : 'Removed'}
                            {sourceKindChange(result, source.id)}
                            {source.state === 'changed' && source.beforeMode !== source.afterMode
                              ? ' · mode changed'
                              : ''}
                          </td>
                          <td>
                            <details>
                              <summary>View capture</summary>
                              <p className="control-meta">
                                Before <code>{source.beforeSha256 ?? 'Absent'}</code>
                              </p>
                              <p className="control-meta">
                                After <code>{source.afterSha256 ?? 'Absent'}</code>
                              </p>
                              <p className="control-meta">
                                Mode{' '}
                                {source.beforeMode === null
                                  ? 'Absent'
                                  : source.beforeMode.toString(8)}{' '}
                                →{' '}
                                {source.afterMode === null
                                  ? 'Absent'
                                  : source.afterMode.toString(8)}
                              </p>
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            {comparison.entries.added.length > 0 && (
              <details className="live-details">
                <summary>Added signals</summary>
                <SignalRows entries={comparison.entries.added} capture={capture} />
              </details>
            )}
            {comparison.entries.removed.length > 0 && baseline.capture && (
              <details className="live-details">
                <summary>Removed signals</summary>
                <SignalRows entries={comparison.entries.removed} capture={baseline.capture} />
              </details>
            )}
          </>
        ) : (
          <p className="control-meta">
            {comparison.reason === 'no-baseline'
              ? 'No earlier review was recorded when this check ran.'
              : comparison.reason === 'profile-changed'
                ? 'Analysis profile changed. Source and signal differences are unavailable.'
                : comparison.reason === 'incomplete'
                  ? 'Coverage is incomplete. Removed or unchanged signals cannot be established.'
                  : 'The reviewed baseline is unavailable.'}
          </p>
        )}
      </section>
      {!capture.complete && (
        <details className="live-details" open>
          <summary>Coverage gaps</summary>
          <ul>
            {capture.coverage.gaps.map((gap, index) => (
              <li key={`${gap.code}:${gap.sourceId}:${index}`}>
                {GAP_LABELS[gap.code]}
                {gap.label ? ` · ${gap.label}` : ''}
              </li>
            ))}
          </ul>
          {(capture.coverage.omittedSources > 0 || capture.coverage.omittedEntries > 0) && (
            <p className="control-meta">
              {capture.coverage.omittedSources} sources · {capture.coverage.omittedEntries} signals
              omitted
            </p>
          )}
        </details>
      )}
      {STAGES.map(([stage, label]) => {
        const entries = capture.entries.filter((entry) => entry.stage === stage);
        return (
          <details
            className="live-details"
            key={stage}
            open={entries.some((entry) => entry.severity === 'error')}
          >
            <summary>
              {label} <span className="muted">{entries.length}</span>
            </summary>
            {entries.length ? (
              <SignalRows
                entries={entries}
                capture={capture}
                onMakeTasksManual={stage === 'on-open' ? onMakeTasksManual : undefined}
                taskControlsDisabled={taskControlsDisabled}
              />
            ) : (
              <p className="control-meta">
                {capture.complete
                  ? 'No signals recorded in this capture.'
                  : 'No signals recorded in the available coverage.'}
              </p>
            )}
          </details>
        );
      })}
      <details className="live-details">
        <summary>Sources and capture</summary>
        <div className="table-scroll">
          <table className="data-table workspace-review-sources">
            <thead>
              <tr>
                <th>Source</th>
                <th>Kind</th>
                <th>Fingerprint</th>
              </tr>
            </thead>
            <tbody>
              {capture.sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <code>{source.label}</code>
                    {source.role === 'git-metadata' && (
                      <span className="control-meta"> · Git metadata</span>
                    )}
                    {source.labelHidden && <span className="control-meta"> · label withheld</span>}
                  </td>
                  <td>{source.kind}</td>
                  <td>
                    <code>{source.sha256}</code>
                    <p className="control-meta">Mode {source.mode.toString(8)}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="control-meta">
          Capture <code>{capture.captureSha256}</code>
        </p>
        <p className="control-meta">
          Engine {capture.profile.engineVersion} · <code>{capture.profile.id}</code>
        </p>
        <p className="control-meta">
          Runtime <code>{capture.profile.runtimeSha256}</code>
        </p>
        <p className="control-meta">
          Scope <code>{capture.profile.scopeSha256}</code>
        </p>
        {capture.coverage.exclusions.includes('stroq-state') && (
          <p className="control-meta">
            Stroq's local state directory was excluded from this capture.
          </p>
        )}
        {baseline.reviewedAt && (
          <p className="control-meta">
            Compared with review recorded {new Date(baseline.reviewedAt).toLocaleString()} ·{' '}
            <code>{baseline.revision}</code>
          </p>
        )}
      </details>
      <details className="live-details">
        <summary>Evidence limits</summary>
        <ul>
          {WORKSPACE_REVIEW_LIMITATIONS.map((value) => (
            <li key={value}>{value}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
