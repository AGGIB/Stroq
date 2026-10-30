'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Archive, ArrowRight, RefreshCw } from 'lucide-react';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import {
  quarantineHref,
  quarantineSelection,
  type QuarantineFilter,
} from '@/lib/quarantine-navigation';
import type { SkillQuarantineRecord, SkillQuarantineReceipt } from '@/lib/skill-quarantine';
import { SkillsTabs } from './inventory';
import { useSkillQuarantine } from './use-skill-quarantine';
import { QUARANTINE_LABELS, QuarantineDetail, quarantineNeedsAttention } from './quarantine-detail';
import { InventorySource, inventorySourceLabel } from './inventory-source';
export function SkillQuarantinePage() {
  const { localAccess, workspaceId, state, loading, error, refresh } = useSkillQuarantine();
  const location = quarantineSelection(useSearchParams());
  const [receipt, setReceipt] = useState<SkillQuarantineReceipt | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null),
    refreshButton = useRef<HTMLButtonElement | null>(null),
    page = useRef<HTMLDivElement | null>(null);
  const selected =
    localAccess && state?.workspaceId === location.workspaceId
      ? (state.records.find((record) => record.id === location.recordId) ?? null)
      : null;
  const select = (record: SkillQuarantineRecord | null, trigger?: HTMLElement) => {
    if (record && !selected) returnFocus.current = trigger ?? null;
    const href = quarantineHref(record?.id ?? null, state?.workspaceId ?? null, location.filter);
    if (record) window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  };
  const filter = (value: QuarantineFilter) =>
    window.history.pushState(
      null,
      '',
      quarantineHref(location.recordId, location.workspaceId, value),
    );
  const records = state?.records ?? [],
    attention = records.filter(quarantineNeedsAttention).length;
  const rows = records.filter(
    (record) =>
      location.filter === 'all' ||
      (location.filter === 'quarantined'
        ? record.status === 'quarantined'
        : quarantineNeedsAttention(record)),
  );
  return (
    <div
      className="page-stack"
      ref={page}
      tabIndex={-1}
      role="region"
      aria-label="Skill quarantine"
    >
      <PageHeading
        title="Skill quarantine"
        actions={
          <button
            className="button"
            ref={refreshButton}
            disabled={!localAccess || loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} className={loading ? 'spin' : undefined} />
            {loading ? 'Rechecking…' : 'Recheck folders'}
          </button>
        }
      />
      <SkillsTabs active="quarantine" />
      {error && (
        <p className="control-error" role="alert">
          {error}
          {state ? ' Earlier observations remain visible.' : ''}
        </p>
      )}
      {localAccess && receipt && receipt.workspaceId === workspaceId && (
        <div className="quarantine-outcome" role="status">
          <strong>
            {receipt.status === 'restored' ? 'Captured files restored' : 'Captured folder moved'}
          </strong>
          <p>Start a new agent session. Loaded instructions and other copies remain available.</p>
          <button className="inline-link" onClick={() => setReceipt(null)}>
            Dismiss
          </button>
        </div>
      )}
      {localAccess && (location.invalid || (state && location.recordId && !selected)) && (
        <p className="control-error" role="status">
          {location.invalid
            ? 'This retained-version link is invalid.'
            : state?.workspaceId !== location.workspaceId
              ? 'This link belongs to another workspace.'
              : 'The retained record could not be read in this workspace.'}
          <button className="inline-link" onClick={() => select(null)}>
            Clear selection
          </button>
        </p>
      )}
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect the local engine"
            description="Open your private server link to inspect retained versions."
          />
          <div className="panel-body">
            <Link className="button" href="/settings/">
              Connection settings <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : (
        <>
          <div className="inventory-summary">
            <div>
              <span>Removed from path</span>
              <strong>
                {state ? records.filter((record) => record.status === 'quarantined').length : '—'}
              </strong>
            </div>
            <div>
              <span>Needs attention</span>
              <strong>{state ? attention : '—'}</strong>
            </div>
            <div>
              <span>Retained versions</span>
              <strong>{state ? records.length : '—'}</strong>
            </div>
          </div>
          {state && !state.available && (
            <p className="control-error" role="status">
              Quarantine operations are unavailable · {state.reason?.replaceAll('-', ' ')}. Retained
              data is not discarded.
            </p>
          )}
          <Panel
            title="Retained skill versions"
            actions={<Badge tone="muted">Discovery paths</Badge>}
          >
            <div className="inventory-toolbar">
              <div className="filter-tabs" role="group" aria-label="Retained version status">
                {(['all', 'quarantined', 'attention'] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={location.filter === value}
                    className={location.filter === value ? 'is-active' : ''}
                    onClick={() => filter(value)}
                  >
                    {value === 'all'
                      ? 'All'
                      : value === 'quarantined'
                        ? 'Quarantined'
                        : 'Needs attention'}
                  </button>
                ))}
              </div>
              {state && (
                <span className="control-meta">
                  Rechecked {new Date(state.generatedAt).toLocaleString('en-GB')}
                </span>
              )}
            </div>
            {loading && !state ? (
              <div className="control-empty" role="status">
                Checking original folders and retained fingerprints…
              </div>
            ) : !rows.length ? (
              <EmptyState
                title={
                  state?.gaps.length
                    ? 'Some retained records could not be read'
                    : records.length
                      ? 'No versions in this view'
                      : 'No quarantined skills'
                }
                description={
                  state?.gaps.length
                    ? 'Inspect the storage gaps before relying on this view.'
                    : 'Open an installed skill to preview quarantine. Files are never moved automatically.'
                }
              />
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Retained skill versions"
              >
                <table className="data-table quarantine-table">
                  <thead>
                    <tr>
                      <th>Skill</th>
                      <th>Source</th>
                      <th>Scope</th>
                      <th>Current observation</th>
                      <th>Retained since</th>
                      <th aria-label="Open details" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <button
                            className="inventory-name"
                            aria-label={`Inspect retained ${record.artifact.name} · ${inventorySourceLabel({ ...record.artifact, kind: 'skill' })}`}
                            onClick={(event) => select(record, event.currentTarget)}
                          >
                            <Archive size={18} />
                            <span>
                              <strong>{record.artifact.name}</strong>
                            </span>
                          </button>
                        </td>
                        <td>
                          <InventorySource item={{ ...record.artifact, kind: 'skill' }} />
                        </td>
                        <td>
                          {record.artifact.scope === 'user' ? 'User · all workspaces' : 'Workspace'}
                        </td>
                        <td>
                          <Badge tone={quarantineNeedsAttention(record) ? 'orange' : 'muted'}>
                            {QUARANTINE_LABELS[record.status]}
                          </Badge>
                        </td>
                        <td className="control-meta">
                          {new Date(record.createdAt).toLocaleDateString('en-GB')}
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Inspect retained ${record.artifact.name} · ${inventorySourceLabel({ ...record.artifact, kind: 'skill' })}`}
                            onClick={(event) => select(record, event.currentTarget)}
                          >
                            <ArrowRight size={16} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {state && (
            <details className="panel">
              <summary className="panel-heading">
                <h2>Scope & retention</h2>
                <Badge tone={state.gaps.length ? 'orange' : 'muted'}>
                  {state.gaps.length ? state.gaps.length + ' storage gaps' : 'Local files'}
                </Badge>
              </summary>
              <div className="panel-body">
                {state.gaps.map((gap, index) => (
                  <p className="control-meta" key={index}>
                    {gap.scope} · {gap.code.replaceAll('-', ' ')}
                  </p>
                ))}
                {state.limitations.map((limit) => (
                  <p className="control-meta" key={limit}>
                    {limit}
                  </p>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      <QuarantineDetail
        record={selected}
        workspaceId={state?.workspaceId ?? ''}
        href={quarantineHref(selected?.id ?? null, state?.workspaceId ?? null, location.filter)}
        limitations={state?.limitations ?? []}
        disabled={loading || Boolean(error) || !state?.available}
        onClose={() => select(null)}
        onReturnFocus={() => {
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
          else if (refreshButton.current && !refreshButton.current.disabled)
            refreshButton.current.focus();
          else page.current?.focus();
          returnFocus.current = null;
        }}
        onCompleted={(value) => {
          setReceipt(value);
          select(null);
          void refresh(false);
        }}
        onRechecked={() => void refresh(false)}
      />
    </div>
  );
}
