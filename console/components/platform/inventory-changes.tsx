'use client';
import { Badge } from '@/components/platform-ui';
import { CAPABILITIES } from '@/lib/inventory';
import type { InventoryComparison, InventoryChanges } from '@/lib/inventory-changes';
import type { InventoryEvidenceMatch } from '@/lib/inventory-evidence';

const FILE_STATES = {
  added: 'Added',
  modified: 'Modified',
  removed: 'Removed',
  'unobserved-before': 'Not captured before',
  'unobserved-current': 'Not captured now',
};
function bytes(value: number | null, absent: boolean) {
  return value === null ? (absent ? 'Absent' : 'Not captured') : `${value.toLocaleString()} bytes`;
}
function SignalChanges({
  title,
  matches,
  comparison,
  previous = false,
}: {
  title: string;
  matches: InventoryEvidenceMatch[];
  comparison: InventoryComparison;
  previous?: boolean;
}) {
  const report = previous ? comparison.baseline.evidence : comparison.current;
  const files = new Map(report?.files.map((file) => [file.id, file]) ?? []);
  return (
    <div>
      <h4>
        {title} · {matches.length}
      </h4>
      {matches.map((match) => (
        <article
          className="artifact-signal"
          key={`${match.fileId}:${match.ruleId}:${match.variant}`}
        >
          <div className="artifact-signal-heading">
            <strong>{match.title}</strong>
            <Badge
              tone={
                match.severity === 'critical' || match.severity === 'high'
                  ? 'red'
                  : match.severity === 'medium'
                    ? 'orange'
                    : 'muted'
              }
            >
              {match.severity}
            </Badge>
          </div>
          <p>{files.get(match.fileId)?.label ?? 'Captured file'}</p>
          <span className="control-meta">
            {match.ruleId} · {match.variant}
          </span>
        </article>
      ))}
    </div>
  );
}
function ChangedFiles({ changes }: { changes: InventoryChanges['files'] }) {
  return (
    <details className="artifact-section" open={changes.rows.length > 0}>
      <summary>
        Files <span>{changes.rows.length} captured changes</span>
      </summary>
      {(!changes.completeBefore || !changes.completeAfter) && (
        <p className="control-meta">
          File details are incomplete. Unobserved files are not confirmed additions or removals.
        </p>
      )}
      {changes.rows.map((file) => (
        <article className="artifact-file" key={file.id}>
          <div>
            <strong>{file.label}</strong>
            <Badge tone={file.state === 'added' || file.state === 'modified' ? 'orange' : 'muted'}>
              {FILE_STATES[file.state]}
            </Badge>
          </div>
          <p className="control-meta">
            {bytes(file.beforeBytes, file.state === 'added')} →{' '}
            {bytes(file.afterBytes, file.state === 'removed')}
          </p>
          {file.labelHidden && <p className="control-meta">File label hidden.</p>}
          <details className="setup-next">
            <summary>Fingerprints</summary>
            <p className="control-meta">Reviewed</p>
            <code className="inventory-digest">
              {file.beforeSha256 ?? (file.state === 'added' ? 'Absent' : 'Not captured')}
            </code>
            <p className="control-meta">Current</p>
            <code className="inventory-digest">
              {file.afterSha256 ?? (file.state === 'removed' ? 'Absent' : 'Not captured')}
            </code>
          </details>
        </article>
      ))}
      <p className="control-meta">
        {changes.unchanged} matching captured {changes.unchanged === 1 ? 'file' : 'files'}.
      </p>
    </details>
  );
}
export function InventoryChangesPanel({ comparison }: { comparison: InventoryComparison }) {
  const { baseline, changes } = comparison;
  const status =
    baseline.status === 'missing'
      ? 'No prior review'
      : baseline.status === 'legacy'
        ? 'Earlier details unavailable'
        : baseline.status === 'invalid'
          ? 'Baseline unavailable'
          : changes?.mcp && !changes.mcp.entryChanged && changes.mcp.sourceChanged
            ? 'Entry unchanged · source changed'
            : changes?.artifactChanged
              ? 'Revision changed'
              : changes?.engineChanged
                ? 'Analysis profile changed'
                : 'Matches reviewed revision';
  return (
    <section className="artifact-evidence" aria-label="Changes since explicit review">
      <div className="artifact-verdict">
        <div>
          <span className="control-meta">Since review</span>
          <strong>{status}</strong>
        </div>
        <Badge
          tone={
            baseline.status === 'invalid' ||
            changes?.artifactChanged ||
            changes?.engineChanged ||
            changes?.mcp?.sourceChanged
              ? 'orange'
              : 'muted'
          }
        >
          {baseline.status === 'available' ? 'Compared captures' : 'Comparison unavailable'}
        </Badge>
      </div>
      {baseline.reviewedAt && (
        <p className="control-meta">
          Reviewed {new Date(baseline.reviewedAt).toLocaleString('en-GB')}.
        </p>
      )}
      {baseline.status === 'missing' && (
        <p className="control-meta">Review this version to establish a comparison baseline.</p>
      )}
      {baseline.status === 'legacy' && (
        <p className="control-meta">
          The earlier review retained only a fingerprint. Previous file and analysis details were
          not saved.
        </p>
      )}
      {baseline.status === 'invalid' && (
        <p className="control-error" role="alert">
          Previous review details could not be read safely. Current inspection remains separate.
        </p>
      )}
      {changes && (
        <>
          {changes.engineChanged && comparison.current.artifact.kind === 'skill' && (
            <p className="control-meta">
              The recorded analysis profile changed. Signal and capability deltas are unavailable.
            </p>
          )}
          {changes.mcp ? (
            <>
              <dl className="property-list">
                <div>
                  <dt>Selected entry</dt>
                  <dd>{changes.mcp.entryChanged ? 'Changed' : 'Unchanged'}</dd>
                </div>
                <div>
                  <dt>Source configuration file</dt>
                  <dd>{changes.mcp.sourceChanged ? 'Changed' : 'Unchanged'}</dd>
                </div>
                <div>
                  <dt>Transport</dt>
                  <dd>
                    {changes.mcp.transport.before} → {changes.mcp.transport.after}
                  </dd>
                </div>
                <div>
                  <dt>Stroq wrapper</dt>
                  <dd>
                    {changes.mcp.wrapper.before === 'configured' ? 'Configured' : 'Not configured'}{' '}
                    → {changes.mcp.wrapper.after === 'configured' ? 'Configured' : 'Not configured'}
                  </dd>
                </div>
                <div>
                  <dt>Strict flag</dt>
                  <dd>
                    {changes.mcp.strict.before ? 'Present' : 'Absent'} →{' '}
                    {changes.mcp.strict.after ? 'Present' : 'Absent'}
                  </dd>
                </div>
              </dl>
              <p className="control-meta">
                A source-file change can belong to another entry. Commands, arguments and
                environment values are not retained for comparison.
              </p>
            </>
          ) : (
            <>
              <ChangedFiles changes={changes.files} />
              {changes.artifactChanged && changes.files.rows.length === 0 && (
                <p className="control-meta">
                  The artifact fingerprint changed beyond the retained file details.
                </p>
              )}
              <details className="artifact-section" open={changes.signals.added.length > 0}>
                <summary>
                  Matched signals{' '}
                  <span>
                    {changes.signals.comparable
                      ? `${changes.signals.added.length} new · ${changes.signals.removed.length} no longer matched`
                      : 'Not comparable'}
                  </span>
                </summary>
                {changes.signals.comparable ? (
                  <>
                    {changes.signals.added.length > 0 && (
                      <SignalChanges
                        title="New matched signals"
                        matches={changes.signals.added}
                        comparison={comparison}
                      />
                    )}
                    {changes.signals.removed.length > 0 && (
                      <SignalChanges
                        title="No longer matched"
                        matches={changes.signals.removed}
                        comparison={comparison}
                        previous
                      />
                    )}
                    <p className="control-meta">
                      {changes.signals.unchanged} matching signal records. Static findings do not
                      establish an attack or remediation.
                    </p>
                  </>
                ) : (
                  <p className="control-meta">
                    The analysis profiles or retained scan details do not support an exact signal
                    comparison.
                  </p>
                )}
              </details>
              <details className="artifact-section" open={changes.capabilities.rows.length > 0}>
                <summary>
                  Static capability counts{' '}
                  <span>
                    {changes.capabilities.comparable
                      ? changes.capabilities.rows.length
                      : 'Not comparable'}
                  </span>
                </summary>
                {changes.capabilities.comparable ? (
                  changes.capabilities.rows.length ? (
                    changes.capabilities.rows.map((row) => (
                      <div className="protection-check" key={row.kind}>
                        <span>{CAPABILITIES[row.kind]}</span>
                        <Badge tone="muted">
                          {row.before} → {row.after}
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <p className="control-meta">Captured capability counts match.</p>
                  )
                ) : (
                  <p className="control-meta">
                    The analysis profiles or static inspection scope do not support a capability
                    comparison.
                  </p>
                )}
              </details>
            </>
          )}
        </>
      )}
      <details className="artifact-section">
        <summary>Comparison scope & limits</summary>
        <ul>
          {comparison.limitations.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
