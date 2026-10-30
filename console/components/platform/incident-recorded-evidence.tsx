'use client';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { ACTION_LABELS } from '@/lib/incident-comparison';
import type {
  EvidenceCollectionStatus,
  RecordedOriginKind,
  RecordedScopeKind,
} from '@/lib/incident-recorded-evidence';
import type { IncidentRecordedEvidenceAction } from './use-incident-recorded-evidence';

const ORIGINS: Record<RecordedOriginKind, string> = {
  url: 'URLs',
  host: 'Hosts',
  pkg: 'Packages',
  pipe_shell: 'Shell pipelines',
  encoded: 'Encoded input',
  digest: 'Digests',
};
const SCOPES: Record<RecordedScopeKind, string> = {
  void: 'Invalid task permission',
  hard: 'Hard task refusal',
  scope: 'Outside task scope',
  ask: 'Task needs approval',
  policy: 'Policy refusal retained',
  escalated: 'One-use extension recorded',
  'in-scope': 'Within recorded task scope',
};
const missing = (status: EvidenceCollectionStatus, label: string) =>
  status === 'unavailable' ? `${label} unavailable` : `${label} not recorded`;

export function IncidentRecordedEvidencePanel({
  action,
  disabled,
}: {
  action: IncidentRecordedEvidenceAction;
  disabled: boolean;
}) {
  const report = action.report;
  const originCount = report?.provenance.values.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const suspectCount = report?.provenance.values.reduce((sum, row) => sum + row.suspect, 0) ?? 0;
  const gapCount =
    report?.provenanceIncomplete.values.reduce((sum, row) => sum + row.count, 0) ?? 0;
  const originsAvailable = report && ['recorded', 'partial'].includes(report.provenance.status);
  const gapsAvailable =
    report && ['recorded', 'partial'].includes(report.provenanceIncomplete.status);
  return (
    <section
      className="incident-recorded-evidence"
      aria-label="Recorded evidence for this finding"
      aria-busy={action.loading}
    >
      <div className="incident-evidence-heading">
        <h3>Recorded evidence</h3>
        <button
          className="icon-button"
          aria-label="Refresh recorded evidence"
          title="Refresh recorded evidence"
          disabled={disabled || action.loading || !action.available}
          onClick={action.refresh}
        >
          {action.loading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}
        </button>
      </div>
      {action.loading && (
        <p className="control-meta" role="status">
          Reading recorded evidence…
        </p>
      )}
      {action.error && (
        <p className="control-error" role="alert">
          {action.error}
        </p>
      )}
      {!action.available && (
        <p className="control-meta">Connect the local engine to read this entry.</p>
      )}
      {report && (
        <>
          <div className="incident-evidence-summary">
            <Badge tone="muted">
              {report.effect === 'deny'
                ? 'Deny recorded'
                : report.effect === 'ask'
                  ? 'Approval required'
                  : 'Suspect scan recorded'}
            </Badge>
            {report.scope.status === 'recorded' && report.scope.kind && (
              <Badge tone="muted">{SCOPES[report.scope.kind]}</Badge>
            )}
            {(report.window.truncated || report.window.omitted > 0) && (
              <Badge tone="orange">Partial journal window</Badge>
            )}
          </div>
          <div className="incident-class-list">
            {report.classes.values.map((value) => (
              <Badge key={value} tone="muted">
                {ACTION_LABELS[value]}
              </Badge>
            ))}
            {report.classes.status === 'recorded' && report.classes.values.length === 0 && (
              <span className="control-meta">Recorded classes: none</span>
            )}
            {['not-recorded', 'unavailable'].includes(report.classes.status) && (
              <span className="control-meta">
                {missing(report.classes.status, 'Action classes')}
              </span>
            )}
            {report.classes.status === 'partial' && (
              <Badge tone="orange">{report.classes.omitted} omitted</Badge>
            )}
          </div>
          <dl className="incident-evidence-counts">
            <div>
              <dt>Origin matches</dt>
              <dd>
                {originsAvailable ? (
                  <>
                    <strong>{originCount} recorded</strong>
                    <span>
                      {suspectCount} marked suspect
                      {report.provenance.status === 'partial' ? ' · incomplete' : ''}
                    </span>
                  </>
                ) : (
                  <span>{missing(report.provenance.status, 'Origin matches')}</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Origin gaps</dt>
              <dd>
                {gapsAvailable ? (
                  <>
                    <strong>{gapCount} recorded</strong>
                    {report.provenanceIncomplete.status === 'partial' && (
                      <span>Incomplete field</span>
                    )}
                  </>
                ) : (
                  <span>{missing(report.provenanceIncomplete.status, 'Origin gaps')}</span>
                )}
              </dd>
            </div>
          </dl>
          {report.scan && (
            <div className="incident-evidence-scan">
              <span>
                Scanner score{' '}
                <strong>
                  {report.scan.status === 'recorded'
                    ? report.scan.score?.toFixed(2)
                    : 'Unavailable'}
                </strong>
              </span>
              <span>
                {report.scan.status === 'unavailable'
                  ? 'Trust exemption unavailable'
                  : report.scan.trusted === true
                    ? 'Trust exemption recorded'
                    : report.scan.trusted === false
                      ? 'No trust exemption recorded'
                      : 'Trust exemption not recorded'}
              </span>
            </div>
          )}
          <details className="incident-evidence-details">
            <summary>Evidence details</summary>
            {report.provenance.values.length > 0 && (
              <>
                <h4>Recorded origin matches</h4>
                <ul>
                  {report.provenance.values.map((row) => (
                    <li key={row.kind}>
                      {ORIGINS[row.kind]} · {row.count} {row.count === 1 ? 'match' : 'matches'} ·{' '}
                      {row.suspect} marked suspect
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.provenanceIncomplete.values.length > 0 && (
              <>
                <h4>Recorded origin gaps</h4>
                <ul>
                  {report.provenanceIncomplete.values.map((row) => (
                    <li key={row.kind}>
                      {ORIGINS[row.kind]} · {row.count} {row.count === 1 ? 'gap' : 'gaps'}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {report.provenance.omitted > 0 && (
              <p>{report.provenance.omitted} origin-match entries omitted.</p>
            )}
            {report.provenanceIncomplete.omitted > 0 && (
              <p>{report.provenanceIncomplete.omitted} origin-gap entries omitted.</p>
            )}
            {report.scope.status !== 'recorded' && (
              <p>
                Task scope {report.scope.status === 'unavailable' ? 'unavailable' : 'not recorded'}.
              </p>
            )}
            <p>
              Journal #{report.binding.sequence} · captured{' '}
              {new Date(report.capturedAt).toLocaleString('en-GB')}
            </p>
            <ul>
              {report.limitations.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
