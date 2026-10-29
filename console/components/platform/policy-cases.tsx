'use client';
import Link from 'next/link';
import { Dialog } from 'radix-ui';
import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { ACTION_LABELS } from '@/lib/incident-comparison';
import { incidentHref } from '@/lib/incident-navigation';
import type { PolicyCase } from '@/lib/policy-cases';
import { PolicyCaseScenarios } from './policy-case-scenarios';
import { usePolicyCases } from './use-policy-cases';
import { usePolicyCaseAction } from './use-policy-case-action';

function RemovePolicyCaseDialog({
  record,
  onClose,
  onCompleted,
}: {
  record: PolicyCase | null;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const action = usePolicyCaseAction({ open: record !== null, record, onCompleted });
  const heading = useRef<HTMLHeadingElement | null>(null);
  return (
    <Dialog.Root
      open={record !== null}
      onOpenChange={(value) => {
        if (!value && !action.busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content policy-case-dialog"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            heading.current?.focus();
          }}
        >
          <div className="dialog-header">
            <Dialog.Title ref={heading} tabIndex={-1}>
              Remove saved check
            </Dialog.Title>
            <Dialog.Description>
              This removes a gate from future policy candidates.
            </Dialog.Description>
            <Dialog.Close
              className="dialog-close icon-button"
              aria-label="Close check removal"
              disabled={action.busy}
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          {record && (
            <>
              <div className="incident-class-list">
                {record.classes.map((value) => (
                  <Badge key={value} tone="muted">
                    {ACTION_LABELS[value]}
                  </Badge>
                ))}
              </div>
              <PolicyCaseScenarios
                scenarios={record.expected.map((item) => ({
                  taint: item.taint,
                  expected: item.effect,
                }))}
              />
              {action.loading && (
                <p className="control-meta" role="status">
                  <LoaderCircle className="spin" size={16} aria-hidden="true" />
                  Reading current saved checks…
                </p>
              )}
              {action.error && (
                <p className="control-error" role="alert">
                  {action.error}
                </p>
              )}
              {action.mutationError && (
                <p className="control-error" role="alert">
                  {action.mutationError}
                </p>
              )}
              {action.message && (
                <p className="control-meta" role="status">
                  {action.message}
                </p>
              )}
              {action.receipt ? (
                <div className="policy-case-complete" role="status">
                  <Check size={18} aria-hidden="true" />
                  Saved check removed.
                </div>
              ) : action.state && !action.selectionMatches ? (
                <p className="control-meta" role="status">
                  This exact check is no longer present in current saved checks.
                </p>
              ) : (
                action.state &&
                !action.needsRecheck && (
                  <>
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        checked={action.ackWeakenChecks}
                        disabled={action.busy}
                        onChange={(event) => action.acknowledge('weaken', event.target.checked)}
                      />
                      <span>I understand removing this check weakens the regression gate.</span>
                    </label>
                    <label className="policy-ack">
                      <input
                        type="checkbox"
                        checked={action.ackSharedScope}
                        disabled={action.busy}
                        onChange={(event) => action.acknowledge('shared', event.target.checked)}
                      />
                      <span>
                        Remove this check across workspaces using this Stroq data directory.
                      </span>
                    </label>
                  </>
                )
              )}
              <div className="dialog-footer policy-case-dialog-actions">
                {(action.needsRecheck || action.error) && (
                  <button
                    className="button"
                    disabled={action.loading || action.busy}
                    onClick={() => void action.recheck()}
                  >
                    <RefreshCw size={16} aria-hidden="true" />
                    Recheck
                  </button>
                )}
                {!action.receipt && (
                  <button
                    className="button"
                    disabled={
                      action.loading ||
                      action.busy ||
                      !action.selectionMatches ||
                      !action.ackSharedScope ||
                      !action.ackWeakenChecks ||
                      action.needsRecheck
                    }
                    onClick={() => void action.mutate()}
                  >
                    {action.busy ? (
                      <LoaderCircle size={16} className="spin" aria-hidden="true" />
                    ) : (
                      <Trash2 size={16} aria-hidden="true" />
                    )}
                    Confirm removal
                  </button>
                )}
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PolicyCasesPage() {
  const read = usePolicyCases();
  const [selected, setSelected] = useState<PolicyCase | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refresh = useRef<HTMLButtonElement | null>(null);
  const state = read.state;
  return (
    <div className="page-stack">
      <PageHeading
        title="Saved checks"
        actions={
          <>
            <Link href="/policies/" className="button">
              <ArrowLeft size={16} aria-hidden="true" />
              Policies
            </Link>
            <button
              className="button"
              ref={refresh}
              disabled={!read.localAccess || !read.workspaceId || read.loading || selected !== null}
              onClick={() => void read.refresh()}
            >
              <RefreshCw
                size={16}
                className={read.loading ? 'spin' : undefined}
                aria-hidden="true"
              />
              Refresh
            </button>
          </>
        }
      />
      <p className="control-meta">
        All policy candidates using this Stroq data directory · across workspaces.
      </p>
      {read.error && (
        <p className="control-error" role="alert">
          {read.error}
        </p>
      )}
      {!read.localAccess ? (
        <Panel>
          <EmptyState
            title="Connect your local engine"
            description="Open the private local server link to read saved policy checks."
          />
        </Panel>
      ) : !state ? (
        <Panel>
          <div className="control-empty">
            {read.loading ? (
              <>
                <LoaderCircle size={26} className="spin" aria-hidden="true" />
                <p>Checking saved expectations…</p>
              </>
            ) : (
              <p>Refresh to read saved checks.</p>
            )}
          </div>
        </Panel>
      ) : (
        <>
          <div className="policy-cases-status">
            <div>
              <Badge tone={state.report.failed ? 'orange' : 'muted'}>
                {state.cases.length
                  ? `${state.report.passed} / ${state.report.total} match`
                  : 'No saved checks'}
              </Badge>
              <span className="control-meta">2 session contexts per check · Policy simulation</span>
            </div>
            <time className="control-meta" dateTime={state.generatedAt}>
              Checked {new Date(state.generatedAt).toLocaleString('en-GB')}
            </time>
          </div>
          <Panel title="Current policy expectations">
            {state.cases.length === 0 ? (
              <EmptyState
                title="No saved checks yet"
                description="Compare a recorded event, then save its current decisions as expectations."
              />
            ) : (
              <div className="policy-case-list">
                {state.cases.map((record) => {
                  const result = state.report.results.find((item) => item.caseId === record.id)!;
                  return (
                    <article className="policy-case-row" key={record.id}>
                      <div className="policy-case-row-heading">
                        <div className="incident-class-list">
                          {record.classes.map((value) => (
                            <Badge key={value} tone="muted">
                              {ACTION_LABELS[value]}
                            </Badge>
                          ))}
                        </div>
                        <Badge tone={result.passed ? 'muted' : 'orange'}>
                          {result.passed ? 'Matches' : 'Mismatch'}
                        </Badge>
                      </div>
                      <PolicyCaseScenarios scenarios={result.scenarios} />
                      <div className="policy-case-row-footer">
                        <details className="policy-case-source">
                          <summary>Source & fingerprints</summary>
                          <p className="control-meta">
                            Saved {new Date(record.createdAt).toLocaleString('en-GB')}
                            {record.source.workspaceId !== read.workspaceId
                              ? ' · Saved from another workspace context'
                              : ' · Saved from this workspace context'}
                          </p>
                          <Link
                            className="inline-link"
                            href={incidentHref(record.source.incidentId, 'all')}
                          >
                            Source event
                            <ArrowRight size={14} />
                          </Link>
                          <dl className="property-list">
                            <div>
                              <dt>Check</dt>
                              <dd className="inventory-digest">{record.id}</dd>
                            </div>
                            <div>
                              <dt>Source evidence</dt>
                              <dd className="inventory-digest">{record.source.evidenceSha}</dd>
                            </div>
                          </dl>
                        </details>
                        <button
                          className="button"
                          aria-label={`Remove saved check for ${record.classes.map((value) => ACTION_LABELS[value]).join(', ')}`}
                          onClick={(event) => {
                            trigger.current = event.currentTarget;
                            setSelected(record);
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                          Remove
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </Panel>
          <details className="panel">
            <summary className="panel-heading">
              <h2>Snapshot & limits</h2>
            </summary>
            <div className="panel-body">
              <dl className="property-list">
                <div>
                  <dt>Policy</dt>
                  <dd>
                    {state.report.policy.source === 'built-in'
                      ? 'Built-in default'
                      : 'Local policy'}
                  </dd>
                </div>
                <div>
                  <dt>Policy fingerprint</dt>
                  <dd className="inventory-digest">{state.report.policy.semanticSha}</dd>
                </div>
                <div>
                  <dt>Saved checks revision</dt>
                  <dd className="inventory-digest">{state.revision ?? 'No saved store'}</dd>
                </div>
              </dl>
              {state.limitations.map((limit) => (
                <p className="control-meta" key={limit}>
                  {limit}
                </p>
              ))}
            </div>
          </details>
        </>
      )}
      <RemovePolicyCaseDialog
        record={selected}
        onCompleted={() => void read.refresh()}
        onClose={() => {
          setSelected(null);
          requestAnimationFrame(() => {
            if (trigger.current?.isConnected) trigger.current.focus();
            else refresh.current?.focus();
          });
        }}
      />
    </div>
  );
}
