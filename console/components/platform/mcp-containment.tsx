'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowRight, RefreshCw, Server } from 'lucide-react';
import { AgentGlyph, Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { INVENTORY_AGENTS } from '@/lib/inventory';
import type { McpContainmentRecord, McpContainmentReceipt } from '@/lib/mcp-containment';
import {
  mcpContainmentHref,
  mcpContainmentSelection,
  resolveMcpContainmentSelection,
  type McpContainmentFilter,
} from '@/lib/mcp-containment-navigation';
import { SkillsTabs } from './inventory';
import { useMcpContainment } from './use-mcp-containment';
import { McpCallControls } from './mcp-call-controls';
import {
  McpContainmentDetail,
  MCP_SOURCE_LABELS,
  MCP_STATUS_LABELS,
  mcpContainmentNeedsAttention,
  mcpRecordBelongsElsewhere,
} from './mcp-containment-detail';

const REASONS = {
  'context-unavailable': 'The workspace or user recovery location could not be verified.',
  'platform-unsupported': 'Registration changes are unavailable on this operating system.',
  'storage-unavailable': 'Private recovery storage could not be read safely.',
  'runtime-unavailable': 'The local registration engine is unavailable.',
};
export function McpContainmentPage() {
  const location = mcpContainmentSelection(useSearchParams());
  const { localAccess, workspaceId, allowed, state, loading, error, refresh } =
    useMcpContainment(location);
  const resolved = resolveMcpContainmentSelection(location, workspaceId, state?.records ?? null);
  const selected = localAccess && resolved.status === 'selected' ? resolved.record : null;
  const [receipt, setReceipt] = useState<McpContainmentReceipt | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null),
    refreshButton = useRef<HTMLButtonElement | null>(null),
    page = useRef<HTMLDivElement | null>(null);
  const select = (record: McpContainmentRecord | null, trigger?: HTMLElement) => {
    if (record && !selected) returnFocus.current = trigger ?? null;
    const href = mcpContainmentHref(record?.id ?? null, workspaceId, location.filter);
    if (record) window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  };
  const filter = (value: McpContainmentFilter) =>
    window.history.pushState(
      null,
      '',
      mcpContainmentHref(location.recordId, location.workspaceId, value),
    );
  const records = state?.records ?? [];
  const rows = records.filter(
    (record) =>
      location.filter === 'all' ||
      (location.filter === 'removed'
        ? record.status === 'removed'
        : location.filter === 'configured'
          ? record.status === 'configured'
          : mcpContainmentNeedsAttention(record)),
  );
  const invalidLocation = resolved.status === 'invalid' || resolved.status === 'workspace-mismatch';
  return (
    <div
      className="page-stack"
      ref={page}
      tabIndex={-1}
      role="region"
      aria-label="MCP registration history"
    >
      <PageHeading
        title="MCP registrations"
        actions={
          <button
            ref={refreshButton}
            className="button"
            disabled={!allowed || loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={16} className={loading ? 'spin' : undefined} />
            {loading ? 'Rechecking…' : 'Recheck registrations'}
          </button>
        }
      />
      <SkillsTabs active="mcp" />
      <McpCallControls />
      {error && (
        <p className="control-error" role="alert">
          {error}
          {state ? ' Earlier observations remain historical.' : ''}
        </p>
      )}
      {localAccess && receipt?.workspaceId === workspaceId && (
        <div className="mcp-history-outcome" role="status">
          <strong>
            {receipt.status === 'removed'
              ? 'Registration removed from this source'
              : receipt.status === 'configured'
                ? 'Wrapper configured'
                : receipt.proxy
                  ? 'Proxy removed from this registration'
                  : 'Registration restored to this source'}
          </strong>
          <p>
            Restart or reconnect the client. This receipt confirms a configuration change, not an
            active guarded connection.
          </p>
          <button className="inline-link" onClick={() => setReceipt(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect the local engine"
            description="Use your private server link to inspect registration history and recovery copies."
          />
          <div className="panel-body">
            <Link href="/settings/" className="button">
              Connection settings
              <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : invalidLocation ? (
        <Panel>
          <EmptyState
            title={
              resolved.status === 'invalid' ? 'Invalid registration link' : 'Different workspace'
            }
            description="This link does not select a registration in the current workspace."
          />
          <div className="panel-body">
            <Link href="/skills/mcp/" className="button">
              Open local history
              <ArrowRight size={16} />
            </Link>
          </div>
        </Panel>
      ) : resolved.status === 'context-pending' ? (
        <Panel>
          <EmptyState
            title="Workspace context not available"
            description="Open the private server link to establish which workspace this history belongs to."
          />
        </Panel>
      ) : (
        <>
          {resolved.status === 'missing' && (
            <p className="control-error" role="status">
              This exact retained record could not be read. No other registration has been selected.{' '}
              <button className="inline-link" onClick={() => select(null)}>
                Clear selection
              </button>
            </p>
          )}
          <div className="inventory-summary">
            <div>
              <span>Wrapper configured</span>
              <strong>
                {state ? records.filter((record) => record.status === 'configured').length : '—'}
              </strong>
            </div>
            <div>
              <span>Absent from source</span>
              <strong>
                {state ? records.filter((record) => record.status === 'removed').length : '—'}
              </strong>
            </div>
            <div>
              <span>Needs attention</span>
              <strong>{state ? records.filter(mcpContainmentNeedsAttention).length : '—'}</strong>
            </div>
          </div>
          {state && !state.available && (
            <p className="control-error" role="status">
              {REASONS[state.reason ?? 'context-unavailable']} Retained copies are preserved.
            </p>
          )}
          <Panel
            title="Registration history"
            actions={<Badge tone="muted">One source per action</Badge>}
          >
            <div className="inventory-toolbar">
              <div className="filter-tabs" role="group" aria-label="Registration history status">
                {(['all', 'configured', 'removed', 'attention'] as const).map((view) => (
                  <button
                    key={view}
                    className={location.filter === view ? 'is-active' : ''}
                    aria-pressed={location.filter === view}
                    onClick={() => filter(view)}
                  >
                    {view === 'all'
                      ? 'All'
                      : view === 'removed'
                        ? 'Absent from source'
                        : view === 'configured'
                          ? 'Wrapper configured'
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
            {!state ? (
              <EmptyState
                title={loading ? 'Rechecking registrations…' : 'Registration history unavailable'}
                description="Opening history does not change configuration or start an MCP server."
              />
            ) : !rows.length ? (
              <EmptyState
                title={
                  state.gaps.length
                    ? 'Some recovery records could not be verified'
                    : records.length
                      ? 'No registrations in this view'
                      : 'No retained MCP registrations'
                }
                description={
                  state.gaps.length
                    ? 'Inspect recovery storage gaps before relying on this view.'
                    : 'Open an installed MCP entry to preview a proxy or registration change.'
                }
              />
            ) : (
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label="Retained MCP registrations"
              >
                <table className="data-table mcp-history-table">
                  <thead>
                    <tr>
                      <th>Registration</th>
                      <th>Client / scope</th>
                      <th>Current observation</th>
                      <th>Retained since</th>
                      <th aria-label="Inspect registration" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((record) => {
                      const foreign = mcpRecordBelongsElsewhere(record, workspaceId);
                      return (
                        <tr key={record.id}>
                          <td>
                            <button
                              className="inventory-name"
                              onClick={(event) => select(record, event.currentTarget)}
                            >
                              <Server size={18} />
                              <span>
                                <strong>{record.artifact.name}</strong>
                                <small>{MCP_SOURCE_LABELS[record.artifact.configSource]}</small>
                              </span>
                            </button>
                          </td>
                          <td>
                            <span className="table-agent">
                              <AgentGlyph
                                name={
                                  record.artifact.agent === 'claude-desktop'
                                    ? 'Claude Code'
                                    : INVENTORY_AGENTS[record.artifact.agent]!
                                }
                              />
                              {INVENTORY_AGENTS[record.artifact.agent]}
                            </span>
                            <span className="mcp-source-caption">
                              {record.artifact.scope === 'user'
                                ? 'User · multiple workspaces'
                                : foreign
                                  ? 'Different workspace'
                                  : 'Workspace'}
                            </span>
                          </td>
                          <td>
                            <Badge
                              tone={
                                foreign || mcpContainmentNeedsAttention(record) ? 'orange' : 'muted'
                              }
                            >
                              {foreign ? 'Different workspace' : MCP_STATUS_LABELS[record.status]}
                            </Badge>
                          </td>
                          <td className="control-meta">
                            {new Date(record.createdAt).toLocaleDateString('en-GB')}
                          </td>
                          <td>
                            <button
                              className="icon-button"
                              aria-label={'Inspect retained ' + record.artifact.name}
                              onClick={(event) => select(record, event.currentTarget)}
                            >
                              <ArrowRight size={16} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {state && (
            <details className="panel">
              <summary className="panel-heading">
                <h2>Scope & private retention</h2>
                <Badge tone={state.gaps.length ? 'orange' : 'muted'}>
                  {state.gaps.length
                    ? state.gaps.length + ' storage gaps'
                    : 'Local recovery copies'}
                </Badge>
              </summary>
              <div className="panel-body">
                {state.gaps.map((gap, index) => (
                  <p className="control-meta" key={index}>
                    {gap.code.replaceAll('-', ' ')}
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
      <McpContainmentDetail
        record={selected}
        workspaceId={workspaceId ?? ''}
        href={mcpContainmentHref(selected?.id ?? null, workspaceId, location.filter)}
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
          void refresh();
        }}
        onNeedsRecheck={() => void refresh()}
      />
    </div>
  );
}
