'use client';
import { useRef } from 'react';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { ArrowUpRight, X } from 'lucide-react';
import { Badge, ExportButton } from '@/components/platform-ui';
import type { InventoryMonitorState } from '@/lib/inventory-monitor';
import { inventoryHref } from '@/lib/inventory-navigation';
import { InventorySource } from './inventory-source';
const LABELS = {
  added: 'Added',
  changed: 'Changed',
  removed: 'Missing',
  observed: 'Observed',
  unverifiable: 'Unverified',
} as const;
export function InventoryMonitorHistory({
  state,
  open,
  selectedId,
  onSelect,
  onClose,
  onReturnFocus,
  historical,
}: {
  state: InventoryMonitorState | null;
  open: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  onReturnFocus: () => void;
  historical: boolean;
}) {
  const heading = useRef<HTMLHeadingElement | null>(null),
    record = state?.history.records.find((record) => record.id === selectedId);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content inventory-dialog inventory-observation-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              Observed inventory versions
            </Dialog.Title>
            <Dialog.Description>
              Captured metadata · current review and actions require fresh evidence
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close observed inventory history"
            >
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="inventory-review-body">
            {historical && (
              <p className="control-error" role="status">
                Saved watch state could not be refreshed. These captures remain historical.
              </p>
            )}
            {state?.history.status === 'unavailable' ? (
              <p className="control-error" role="status">
                Observed history could not be verified.
              </p>
            ) : !state?.history.records.length ? (
              <p className="control-meta">No observed versions yet.</p>
            ) : (
              <>
                <div
                  className="inventory-observation-versions"
                  role="group"
                  aria-label="Observed versions"
                >
                  {state.history.records.map((item) => (
                    <button
                      key={item.id}
                      className={`button ${item.id === selectedId ? 'is-active' : ''}`}
                      aria-pressed={item.id === selectedId}
                      onClick={() => onSelect(item.id)}
                    >
                      <time dateTime={item.firstObservedAt}>
                        {new Date(item.firstObservedAt).toLocaleString('en-GB')}
                      </time>
                      <span>
                        {item.complete ? 'Complete' : 'Partial'} · {item.itemCount} items
                      </span>
                    </button>
                  ))}
                </div>
                {state.history.omitted > 0 && (
                  <p className="control-meta">
                    {state.history.omitted} earlier versions are outside this history view.
                  </p>
                )}
                {!record ? (
                  <p className="control-meta" role="status">
                    This version is no longer in retained history. Select another capture.
                  </p>
                ) : (
                  <>
                    <div className="artifact-tools">
                      <Badge tone={record.complete ? 'muted' : 'orange'}>Historical capture</Badge>
                      <ExportButton
                        label="Export observed version"
                        filename={`stroq-observed-${record.id}.json`}
                        data={() => ({
                          schema: 'stroq-inventory-observation-export/1',
                          workspaceId: state.workspaceId,
                          record,
                          currentReview: false,
                          hostEnforcement: false,
                        })}
                      />
                    </div>
                    <dl className="property-list">
                      <div>
                        <dt>First observed</dt>
                        <dd>
                          <time dateTime={record.firstObservedAt}>
                            {new Date(record.firstObservedAt).toLocaleString('en-GB')}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Last observed</dt>
                        <dd>
                          <time dateTime={record.lastObservedAt}>
                            {new Date(record.lastObservedAt).toLocaleString('en-GB')}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Coverage</dt>
                        <dd>
                          {record.itemCount} items · {record.gaps} gaps ·{' '}
                          {record.complete ? 'Complete within bounds' : 'Partial'}
                        </dd>
                      </div>
                    </dl>
                    {record.changes.status === 'first' ? (
                      <p className="control-meta">
                        First observed version. No earlier capture to compare.
                      </p>
                    ) : record.changes.status === 'runtime-changed' ? (
                      <p className="control-meta" role="status">
                        Source scope or analysis runtime changed. Source differences are
                        unavailable.
                      </p>
                    ) : (
                      <>
                        {record.changes.status === 'partial' && (
                          <p className="control-meta" role="status">
                            Partial capture. Missing items are unconfirmed.
                          </p>
                        )}
                        {!record.changes.total ? (
                          <p className="control-meta">
                            No source changes from the previous observed version.
                          </p>
                        ) : (
                          <>
                            <h3 className="inventory-observation-title">
                              {record.changes.total} source changes
                            </h3>
                            <div className="inventory-observation-changes">
                              {record.changes.rows.map((row) => (
                                <article
                                  key={row.artifact.id}
                                  className="inventory-observation-change"
                                >
                                  <div>
                                    <strong>{row.artifact.name}</strong>
                                    <Badge tone={row.kind === 'unverifiable' ? 'orange' : 'muted'}>
                                      {LABELS[row.kind]}
                                    </Badge>
                                  </div>
                                  <InventorySource item={row.artifact} />
                                  <span className="control-meta">
                                    {row.artifact.scope === 'user'
                                      ? 'User source'
                                      : 'Workspace source'}
                                  </span>
                                  <details className="artifact-section">
                                    <summary>Captured fingerprints</summary>
                                    {row.beforeSha256 && (
                                      <>
                                        <span className="control-meta">Before</span>
                                        <code className="inventory-digest">{row.beforeSha256}</code>
                                      </>
                                    )}
                                    {row.afterSha256 && (
                                      <>
                                        <span className="control-meta">Observed</span>
                                        <code className="inventory-digest">{row.afterSha256}</code>
                                      </>
                                    )}
                                  </details>
                                  <Link
                                    className="inline-link"
                                    href={inventoryHref(
                                      row.artifact.id,
                                      state.workspaceId,
                                      row.afterSha256 ?? row.beforeSha256,
                                      row.artifact.kind,
                                    )}
                                    onClick={onClose}
                                  >
                                    Inspect captured version{' '}
                                    <ArrowUpRight size={15} aria-hidden="true" />
                                  </Link>
                                </article>
                              ))}
                            </div>
                            {record.changes.omitted > 0 && (
                              <p className="control-meta" role="status">
                                {record.changes.omitted} additional change rows are omitted from
                                this summary. Refresh inventory to inspect current sources.
                              </p>
                            )}
                          </>
                        )}
                      </>
                    )}
                    <details className="artifact-section">
                      <summary>Observation & analysis fingerprints</summary>
                      <code className="inventory-digest">{record.observationSha256}</code>
                      <code className="inventory-digest">{record.runtimeSha256}</code>
                    </details>
                  </>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
