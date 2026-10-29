'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, History, LoaderCircle, RefreshCw } from 'lucide-react';
import { Badge, EmptyState, ExportButton, PageHeading, Panel } from '@/components/platform-ui';
import { policyHistoryHref, policyHistorySelection } from '@/lib/policy-history-navigation';
import { usePolicyHistory } from './use-policy-history';
import { PolicyRestorePreviewPanel } from './policy-restore-preview';
const target = {
  backup: 'Retained policy file',
  'current-default': 'Current bundled default',
  unavailable: 'Recovery unavailable',
};
export function PolicyHistoryPage() {
  const selection = policyHistorySelection(useSearchParams()),
    action = usePolicyHistory(selection),
    { state, entry, receipt } = action;
  return (
    <div className="page-stack">
      <PageHeading
        title="Policy history"
        actions={
          <>
            <Link className="button" href="/policies/">
              <ArrowLeft size={16} aria-hidden="true" />
              Policies
            </Link>
            <button
              className="icon-button"
              aria-label="Refresh recorded policy changes"
              disabled={!action.allowed || !!action.busy}
              onClick={() => void action.refresh()}
            >
              <RefreshCw
                size={17}
                className={action.busy === 'load' ? 'spin' : undefined}
                aria-hidden="true"
              />
            </button>
          </>
        }
      />
      {!action.allowed ? (
        <Panel>
          <EmptyState
            title={selection.invalid ? 'Invalid recovery link' : 'Connect your local engine'}
            description={
              selection.invalid
                ? 'One exact recorded change is required. Another entry has not been selected.'
                : 'Open the private local link to read policy recovery records.'
            }
          />
          <Link className="button" href={selection.invalid ? policyHistoryHref() : '/settings/'}>
            {selection.invalid ? 'Open current history' : 'Connection settings'}
          </Link>
        </Panel>
      ) : (
        <>
          <div className="protection-status">
            <div className="protection-status-main">
              <History size={20} aria-hidden="true" />
              <strong>Shared Stroq policy</strong>
              <span className="muted">All agents using this data directory</span>
            </div>
          </div>
          {action.error && (
            <p className="control-error" role="alert">
              {action.error}
            </p>
          )}
          {action.needsRecheck && (
            <p className="control-meta" role="status">
              Restoration completion is unknown.{' '}
              <button
                className="button small"
                disabled={!!action.busy}
                onClick={() => void action.refresh()}
              >
                Recheck current policy
              </button>
            </p>
          )}
          {receipt && (
            <section className="policy-history-receipt" role="status">
              <Check size={20} aria-hidden="true" />
              <div>
                <strong>
                  {receipt.target === 'current-default'
                    ? 'Current bundled default selected'
                    : 'Saved policy restored'}
                </strong>
                <p className="control-meta">
                  Recorded {new Date(receipt.restoredAt).toLocaleString('en-GB')}. Restart running
                  proxies; existing tasks keep their launch policy.
                </p>
                <Link className="inline-link" href="/agents/tasks/">
                  Review task permissions <ArrowRight size={14} aria-hidden="true" />
                </Link>
                <details className="live-details">
                  <summary>Restore receipt</summary>
                  <p className="control-meta">
                    Policy SHA <code>{receipt.policyFingerprint}</code>
                  </p>
                  <p className="control-meta">
                    Raw SHA <code>{receipt.rawSha ?? 'Policy file absent'}</code>
                  </p>
                  <p className="control-meta">
                    Receipt <code>{receipt.receiptId}</code>
                  </p>
                  <p className="control-meta">
                    {receipt.backupId
                      ? 'The replaced policy was retained privately.'
                      : 'The previous policy file was absent; no file copy was created.'}
                  </p>
                </details>
              </div>
            </section>
          )}
          {action.currentChanged && (
            <p className="control-error" role="alert">
              The restore was acknowledged, but the current policy changed afterwards. Review
              current Policies before another change.
            </p>
          )}
          {state?.history.status === 'partial' && (
            <p className="control-meta" role="status">
              Recorded history is partial
              {state.history.limited ? ' or exceeds the reading limit' : ''}. Valid listed recovery
              targets can still be previewed.
            </p>
          )}
          {state?.history.status === 'unavailable' && (
            <p className="control-error" role="alert">
              Recorded history is unavailable. This is not an empty change history.
            </p>
          )}
          {state && !state.currentValid && (
            <p className="control-error" role="alert">
              The current policy cannot be validated. Restore is unavailable until its source can be
              inspected.
            </p>
          )}
          {!state ? (
            <Panel>
              <div className="control-empty" role="status">
                {action.busy === 'load' ? (
                  <>
                    <LoaderCircle size={28} className="spin" aria-hidden="true" />
                    <p>Reading recorded policy changes…</p>
                  </>
                ) : (
                  <p>Recorded changes are unavailable. Refresh to retry.</p>
                )}
              </div>
            </Panel>
          ) : (
            <div
              className={`policy-history-layout ${!entry && !selection.entryId ? 'is-overview' : ''}`}
            >
              <Panel
                title="Recorded changes"
                subtitle="Intent records do not establish successful application."
              >
                <div className="panel-body">
                  {!state.entries.length ? (
                    <EmptyState
                      title={
                        state.history.status === 'unavailable'
                          ? 'History unavailable'
                          : 'No readable change records'
                      }
                      description={
                        state.history.status === 'ready'
                          ? 'Policy changes made here will retain a recovery record.'
                          : 'Records outside the available coverage cannot be ruled out.'
                      }
                    />
                  ) : (
                    <div className="policy-history-list">
                      {state.entries.map((item) => (
                        <Link
                          key={item.id}
                          className={`policy-history-entry ${entry?.id === item.id ? 'is-active' : ''}`}
                          aria-current={entry?.id === item.id ? 'page' : undefined}
                          href={policyHistoryHref(item.id)}
                        >
                          <span>
                            <strong>{new Date(item.recordedAt).toLocaleString('en-GB')}</strong>
                            <span>{target[item.recovery]}</span>
                          </span>
                          <ArrowRight size={16} aria-hidden="true" />
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </Panel>
              <div className="page-stack">
                {selection.entryId && !entry ? (
                  <Panel>
                    <EmptyState
                      title="This recorded change is unavailable"
                      description="The selected entry is absent from readable history. Another entry has not been substituted."
                    />
                    <Link className="button" href={policyHistoryHref()}>
                      Open current history
                    </Link>
                  </Panel>
                ) : entry ? (
                  <>
                    <Panel
                      title="Recovery target"
                      actions={<Badge>{target[entry.recovery]}</Badge>}
                    >
                      <div className="panel-body">
                        {entry.recovery === 'current-default' && (
                          <p className="control-meta">
                            The earlier policy file was absent. This target uses the current bundled
                            default, not historical default bytes.
                          </p>
                        )}
                        {entry.recovery === 'unavailable' && (
                          <p className="control-meta">
                            The retained bytes could not be verified. No restore is available for
                            this record.
                          </p>
                        )}
                        <details className="live-details">
                          <summary>Record fingerprints</summary>
                          <dl className="property-list">
                            <div>
                              <dt>Record ID</dt>
                              <dd className="inventory-digest">{entry.id}</dd>
                            </div>
                            <div>
                              <dt>Record SHA</dt>
                              <dd className="inventory-digest">{entry.recordSha256}</dd>
                            </div>
                            <div>
                              <dt>Before raw SHA</dt>
                              <dd className="inventory-digest">
                                {entry.beforeRawSha ?? 'Policy file absent'}
                              </dd>
                            </div>
                            <div>
                              <dt>Intended replacement SHA</dt>
                              <dd className="inventory-digest">
                                {entry.afterRawSha ?? 'Policy file absent'}
                              </dd>
                            </div>
                            <div>
                              <dt>Current raw SHA</dt>
                              <dd className="inventory-digest">
                                {state.currentRawSha ?? 'Policy file absent'}
                              </dd>
                            </div>
                          </dl>
                        </details>
                        <div className="policy-history-actions">
                          {!receipt && (
                            <button
                              className="button"
                              disabled={!action.canPrepare || !!action.busy}
                              onClick={() => void action.prepare()}
                            >
                              {action.busy === 'preview' ? (
                                <LoaderCircle size={16} className="spin" aria-hidden="true" />
                              ) : (
                                <RefreshCw size={16} aria-hidden="true" />
                              )}
                              Preview restore
                            </button>
                          )}
                          <ExportButton
                            data={() => action.getReport()}
                            label="Export recovery"
                            filename="stroq-policy-recovery.json"
                          />
                        </div>
                      </div>
                    </Panel>
                    {!receipt && <PolicyRestorePreviewPanel action={action} />}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
