'use client';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/platform-ui';
import type { CodexNetworkControls } from './use-codex-network-controls';
import { NETWORK_KIND_LABEL } from './codex-network-review';
const STANDING = {
  selected: 'Matches the current user declaration',
  changed: 'User settings changed',
  overridden: 'A higher layer overrides this declaration',
  unavailable: 'Current declaration unverified',
} as const;
export function CodexNetworkHistory({
  action,
  recordId = null,
  onCheck,
}: {
  action: CodexNetworkControls;
  recordId?: string | null;
  onCheck: (id: string) => void;
}) {
  const g = action.guard,
    c = action.checks,
    records = g.state?.records ?? [];
  const selected = records.find(
      (record) => record.id === recordId && record.controlContextId === g.state?.controlContextId,
    ),
    focusKey = selected ? `${selected.controlContextId}:${selected.id}` : null,
    target = useRef<HTMLElement | null>(null),
    focused = useRef<string | null>(null);
  useEffect(() => {
    if (action.busy || !focusKey || focused.current === focusKey || !target.current) return;
    focused.current = focusKey;
    target.current.focus({ preventScroll: true });
    target.current.scrollIntoView({ block: 'center', behavior: 'auto' });
  }, [focusKey, action.busy]);
  const missing = g.pending.filter(
    (w) =>
      !records.some((r) => r.id === w.preview.recordId && r.operationId === w.preview.operationId),
  );
  return (
    <section className="codex-network-history" aria-label="Codex network guard history">
      <div className="codex-network-heading">
        <h3>Configuration changes</h3>
        <button
          className="inline-link"
          disabled={!!action.busy || !action.connected}
          onClick={() => void action.refreshHistory()}
        >
          Reload history
        </button>
      </div>
      {g.state?.history === 'unavailable' && (
        <p className="control-error">Recovery storage is unavailable.</p>
      )}
      {missing.map((w) => (
        <div className="codex-network-notice" key={w.preview.operationId} role="status">
          <strong>Configuration change unconfirmed</strong>
          <p>
            Its exact record is absent from this read. Reload history; absence does not prove no
            write occurred.
          </p>
        </div>
      ))}
      {g.foreignPending.length > 0 && (
        <p className="control-meta">
          An unresolved configuration change belongs to another Codex data directory.
        </p>
      )}
      {g.state && g.state.history !== 'unavailable' && !records.length && (
        <p className="control-meta">No retained configuration changes.</p>
      )}
      {[...records]
        .sort((a, b) =>
          a.id === recordId ? -1 : b.id === recordId ? 1 : b.updatedAt.localeCompare(a.updatedAt),
        )
        .map((record) => {
          const unknown = g.pending.some(
            (w) => w.preview.recordId === record.id && w.preview.operationId === record.operationId,
          );
          return (
            <article
              className="codex-network-record"
              key={record.id}
              data-selected={record.id === recordId || undefined}
              data-control-record={record.id}
              ref={record.id === recordId ? target : undefined}
              tabIndex={record.id === recordId ? -1 : undefined}
              aria-label={record.id === recordId ? 'Selected Codex network change' : undefined}
            >
              <div className="codex-network-heading">
                <strong>
                  {record.operationStatus === 'restored'
                    ? 'Previous setting restored'
                    : record.operationStatus === 'unknown' || unknown
                      ? 'Completion unknown'
                      : 'Network-off setting recorded'}
                </strong>
                <Badge
                  tone={
                    record.operationStatus === 'unknown' ||
                    unknown ||
                    record.standing !== 'selected'
                      ? 'orange'
                      : 'muted'
                  }
                >
                  {record.ownership === 'superseded' ? 'Superseded' : record.operationStatus}
                </Badge>
              </div>
              <span className="control-meta">{NETWORK_KIND_LABEL[record.kind]}</span>
              <span className="control-meta">{STANDING[record.standing]}</span>
              {record.ownership === 'superseded' && (
                <p className="control-meta">
                  A newer Stroq change owns these fields. This record cannot be restored.
                </p>
              )}
              {record.retainsInactiveProfile && (
                <p className="control-meta">
                  The inactive owned profile remains in the configuration.
                </p>
              )}
              <div className="codex-network-actions">
                {record.canRestore && record.ownership === 'current' && !unknown && (
                  <button
                    className="button"
                    disabled={!!action.busy || !g.state?.available}
                    onClick={() => void g.prepareRestore(record)}
                  >
                    Preview restore
                  </button>
                )}
                {(unknown || record.operationStatus === 'unknown') && (
                  <button
                    className="button"
                    disabled={!!action.busy}
                    onClick={() => void g.recheck(record)}
                  >
                    Recheck exact change
                  </button>
                )}
              </div>
              <details className="codex-network-evidence">
                <summary>Recorded configuration evidence</summary>
                <span>
                  Updated {new Date(record.updatedAt).toLocaleString('en-GB')} · declaration only,
                  native adoption unverified
                </span>
                <code>{record.candidateSha256}</code>
              </details>
            </article>
          );
        })}
      <h3>Native checks</h3>
      {c.state?.history === 'unavailable' && (
        <p className="control-error">Native check history is unavailable.</p>
      )}
      {c.state && c.state.history !== 'unavailable' && !c.state.jobs.length && (
        <p className="control-meta">No retained native checks.</p>
      )}
      {c.state?.jobs.map((job) => (
        <div className="codex-network-history-check" key={job.id}>
          <div>
            <strong>
              {job.status === 'completed'
                ? job.result?.outcome === 'passed'
                  ? 'Copy refused both connections'
                  : 'Copy check needs review'
                : job.status === 'running'
                  ? 'Check running'
                  : job.status === 'cancelled'
                    ? 'Check cancelled'
                    : 'Check failed'}
            </strong>
            <span className="control-meta">
              {new Date(job.finishedAt ?? job.startedAt).toLocaleString('en-GB')} · isolated
              permission copy
            </span>
          </div>
          <button className="inline-link" onClick={() => onCheck(job.id)}>
            View check
          </button>
        </div>
      ))}
    </section>
  );
}
