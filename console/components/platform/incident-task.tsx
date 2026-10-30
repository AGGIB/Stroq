'use client';
import Link from 'next/link';
import { ArrowRight, LoaderCircle, Search } from 'lucide-react';
import { incidentTaskHref } from '@/lib/incident-task-binding';
import type { IncidentTaskReport } from '@/lib/incident-task';
import type { useIncidentTask } from './use-incident-task';

const RESULTS: Record<Exclude<IncidentTaskReport['status'], 'matched'>, string> = {
  'not-recorded': 'No task ID was recorded for this finding.',
  'invalid-reference': 'The recorded task reference could not be verified.',
  'permit-unavailable': 'The current permission is unavailable.',
  'different-workspace': 'The permission belongs to another workspace.',
  'session-mismatch': 'The recorded session does not match this permission.',
  'time-mismatch': 'The finding falls outside this permission’s validity period.',
  'evidence-unavailable': 'The captured journal could not be verified.',
};

export function IncidentTask({
  action,
  disabled,
}: {
  action: ReturnType<typeof useIncidentTask>;
  disabled: boolean;
}) {
  const { report, loading, error } = action;
  const href = report ? incidentTaskHref(report) : null;
  return (
    <div className="incident-task">
      <button
        className="button"
        disabled={disabled || loading || !action.workspaceId}
        onClick={action.resolve}
      >
        {loading ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}
        {report ? 'Recheck task permission' : 'Find task permission'}
      </button>
      {report && (
        <div aria-live="polite">
          {report.status === 'matched' && report.task && href ? (
            <>
              <div className="incident-detail-tools">
                <span>Current permit · Task {report.task.id.slice(5, 13)}</span>
                <Link className="inline-link" href={href}>
                  Review permission <ArrowRight size={14} />
                </Link>
              </div>
              <p className="control-meta">
                Same recorded task ID; this lookup does not verify the original permit version.
              </p>
            </>
          ) : (
            <p className="control-meta">
              {RESULTS[report.status as Exclude<IncidentTaskReport['status'], 'matched'>]}
            </p>
          )}
          <details className="setup-next">
            <summary>Permission association details</summary>
            <dl className="property-list">
              <div>
                <dt>Checked</dt>
                <dd>{new Date(report.checkedAt).toLocaleString('en-GB')}</dd>
              </div>
              <div>
                <dt>Session relation</dt>
                <dd>{report.sessionRelation}</dd>
              </div>
            </dl>
            {report.task && (
              <div>
                <span className="control-meta">Permit SHA</span>
                <code className="inventory-digest">{report.task.permitSha256}</code>
              </div>
            )}
            {report.journal.sha256 && (
              <div>
                <span className="control-meta">Journal SHA</span>
                <code className="inventory-digest">{report.journal.sha256}</code>
              </div>
            )}
            {report.limitations.map((limit) => (
              <p className="control-meta" key={limit}>
                {limit}
              </p>
            ))}
          </details>
        </div>
      )}
      {error && (
        <p className="control-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
