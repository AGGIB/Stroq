'use client';
import { useEffect, useRef } from 'react';
import { Badge } from '@/components/platform-ui';
import { CODEX_PATH_GUARD_LABELS } from '@/lib/codex-path-guard-client';
import type { CodexPathGuardAction } from './use-codex-path-guard';
const STANDING = {
  selected: 'Matches the current user declaration',
  changed: 'User settings changed',
  overridden: 'A higher layer overrides this declaration',
  unavailable: 'Current declaration unverified',
} as const;
export function CodexPathGuardHistory({
  action,
  recordId = null,
}: {
  action: CodexPathGuardAction;
  recordId?: string | null;
}) {
  const records = action.state?.records ?? [],
    selected = records.find(
      (r) => r.id === recordId && r.controlContextId === action.state?.controlContextId,
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
  const missing = action.pending.filter(
    (w) =>
      !records.some((r) => r.id === w.preview.recordId && r.operationId === w.preview.operationId),
  );
  return (
    <section className="codex-path-history" aria-label="Credential path change history">
      <div className="codex-path-heading">
        <h3>Saved changes</h3>
        <button
          className="inline-link"
          disabled={!!action.busy || !action.connected}
          onClick={() => void action.refresh()}
        >
          Reload history
        </button>
      </div>
      {!action.state || action.state.history === 'unavailable' ? (
        <p className="control-error">Saved changes could not be verified.</p>
      ) : !records.length && !missing.length ? (
        <p className="control-meta">No retained changes.</p>
      ) : null}
      {missing.map((w) => (
        <div className="codex-path-notice" key={w.preview.operationId} role="status">
          <strong>Completion unknown</strong>
          <p className="control-meta">
            {CODEX_PATH_GUARD_LABELS[w.preview.presetId].name} · the exact saved operation is absent
            from this read. Reload history; absence does not prove no write occurred.
          </p>
        </div>
      ))}
      {action.foreignPending.length > 0 && (
        <p className="control-meta">
          An unresolved change belongs to another Codex data directory. Reconnect that context to
          recheck.
        </p>
      )}
      {[...records]
        .sort((a, b) =>
          a.id === recordId ? -1 : b.id === recordId ? 1 : b.updatedAt.localeCompare(a.updatedAt),
        )
        .map((record) => {
          const unknown = action.pending.some(
              (w) =>
                w.preview.recordId === record.id && w.preview.operationId === record.operationId,
            ),
            label = CODEX_PATH_GUARD_LABELS[record.presetId];
          return (
            <article
              className="codex-path-record"
              key={record.id}
              data-selected={record.id === recordId || undefined}
              data-control-record={record.id}
              ref={record.id === recordId ? target : undefined}
              tabIndex={record.id === recordId ? -1 : undefined}
              aria-label={record.id === recordId ? 'Selected Codex path change' : undefined}
            >
              <div className="codex-path-heading">
                <strong>
                  {record.operationStatus === 'restored'
                    ? 'Previous path rule restored'
                    : record.operationStatus === 'unknown' || unknown
                      ? 'Completion unknown'
                      : 'Path denial recorded'}
                </strong>
                <Badge
                  tone={
                    unknown ||
                    record.operationStatus === 'unknown' ||
                    record.standing !== 'selected'
                      ? 'orange'
                      : 'muted'
                  }
                >
                  {record.ownership === 'superseded' ? 'Superseded' : record.operationStatus}
                </Badge>
              </div>
              <div className="codex-path-target">
                <strong>{label.name}</strong>
                <code>{label.path}</code>
              </div>
              <span className="control-meta">{STANDING[record.standing]}</span>
              {record.ownership === 'superseded' && (
                <p className="control-meta">
                  A newer change owns this path rule. This record cannot restore it.
                </p>
              )}
              <div className="codex-path-actions">
                {record.canRestore && record.ownership === 'current' && !unknown && (
                  <button
                    className="button"
                    disabled={!!action.busy || !action.state?.available}
                    onClick={() => void action.prepareRestore(record)}
                  >
                    Preview restore
                  </button>
                )}
                {(unknown || record.operationStatus === 'unknown') && (
                  <button
                    className="button"
                    disabled={!!action.busy}
                    onClick={() => void action.recheck(record)}
                  >
                    Recheck exact change
                  </button>
                )}
              </div>
              <details className="codex-path-evidence">
                <summary>Recorded configuration evidence</summary>
                <span>
                  Updated {new Date(record.updatedAt).toLocaleString('en-GB')} · declaration only,
                  native adoption unverified.
                </span>
                <code>{record.candidateSha256}</code>
              </details>
            </article>
          );
        })}
    </section>
  );
}
