'use client';
import { useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowRight,
  FileCode2,
  Folder,
  LoaderCircle,
  RefreshCw,
  Search,
  Server,
} from 'lucide-react';
import { useInventory } from './use-inventory';
import { quarantineHref } from '@/lib/quarantine-navigation';
import type { SkillQuarantineReceipt } from '@/lib/skill-quarantine';
import type { McpContainmentReceipt } from '@/lib/mcp-containment';
import { mcpContainmentHref } from '@/lib/mcp-containment-navigation';
import {
  inventoryHref,
  inventorySelection,
  inventoryViewMatches,
  type InventoryFilter,
  type InventoryView,
} from '@/lib/inventory-navigation';
import { InventoryBadge, InventoryReview } from './inventory-review';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { INVENTORY_AGENTS, type InventoryItem } from '@/lib/inventory';
import {
  InventorySource,
  InventorySourceCoverage,
  inventorySourceLabel,
  inventorySourceSearchText,
} from './inventory-source';
import { InventorySignalBadge } from './inventory-signal-controls';
import { InventoryMonitor } from './inventory-monitor';
import { CodexSkillSources } from './codex-skill-sources';
import { McpGovernanceControls } from './mcp-governance';

export function SkillsTabs({ active }: { active: 'inventory' | 'scan' | 'quarantine' | 'mcp' }) {
  return (
    <nav className="local-tabs" aria-label="Skills views">
      <Link className={active === 'inventory' ? 'active' : ''} href="/skills/">
        Inventory
      </Link>
      <Link className={active === 'scan' ? 'active' : ''} href="/skills/scan/">
        Scan content
      </Link>
      <Link className={active === 'quarantine' ? 'active' : ''} href="/skills/quarantine/">
        Quarantine
      </Link>
      <Link className={active === 'mcp' ? 'active' : ''} href="/skills/mcp/">
        MCP recovery
      </Link>
    </nav>
  );
}
export function InventoryPage() {
  const { localAccess, data, loading, reviewing, error, refresh, review, needsRecheck } =
    useInventory();
  const location = inventorySelection(useSearchParams());
  const kind = location.kind;
  const view = location.view;
  const [query, setQuery] = useState('');
  const [quarantined, setQuarantined] = useState<SkillQuarantineReceipt | null>(null);
  const [mcpResult, setMcpResult] = useState<McpContainmentReceipt | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement | null>(null);
  const page = useRef<HTMLDivElement | null>(null);
  const selectionNotice = useRef<HTMLParagraphElement | null>(null);
  const currentVersionButton = useRef<HTMLButtonElement | null>(null);
  const sameWorkspace = data?.workspace.id === location.workspaceId;
  const candidate =
    localAccess && sameWorkspace
      ? (data?.items.find((item) => item.id === location.id) ?? null)
      : null;
  const changedVersion = Boolean(candidate && candidate.sha256 !== location.sha256);
  const selected = changedVersion ? null : candidate;
  const select = (item: InventoryItem | null, trigger?: HTMLElement) => {
    if (item && !selected) returnFocus.current = trigger ?? null;
    const href = inventoryHref(
      item?.id ?? null,
      data?.workspace.id ?? null,
      item?.sha256 ?? null,
      kind,
      view,
    );
    if (item) window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
  };
  const setKind = (value: InventoryFilter) =>
    window.history.pushState(
      null,
      '',
      inventoryHref(location.id, location.workspaceId, location.sha256, value, view),
    );
  const setView = (value: InventoryView) =>
    window.history.pushState(
      null,
      '',
      inventoryHref(location.id, location.workspaceId, location.sha256, kind, value),
    );
  const items = data?.items ?? [];
  const visible = items.filter(
    (i) =>
      (kind === 'all' || i.kind === kind) &&
      inventoryViewMatches(i, view) &&
      inventorySourceSearchText(i).toLowerCase().includes(query.toLowerCase()),
  );
  const changed = items.filter((i) => i.state === 'changed' || i.state === 'missing').length;
  const pending = items.filter((i) => i.state === 'unreviewed' || i.state === 'changed').length;
  return (
    <div
      className="page-stack"
      ref={page}
      tabIndex={-1}
      role="region"
      aria-label="Skills and MCP inventory"
    >
      <PageHeading
        title="Skills & MCP"
        actions={
          <>
            <McpGovernanceControls />
            <CodexSkillSources
              disabled={!localAccess || loading || reviewing || !!selected || needsRecheck}
              controlsReady={!loading && (!!data || !!error)}
            />
            <button
              className="button"
              ref={refreshButton}
              disabled={!localAccess || loading || reviewing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={loading ? 'spin' : undefined} aria-hidden="true" />
              {loading ? 'Inspecting…' : 'Refresh inventory'}
            </button>
          </>
        }
      />
      <SkillsTabs active="inventory" />
      {localAccess && (
        <InventoryMonitor
          canRefresh={!loading && !reviewing && !selected && !needsRecheck}
          onCheck={() => {
            if (loading || reviewing || selected || needsRecheck) return false;
            void refresh();
            return true;
          }}
        />
      )}
      {mcpResult && mcpResult.workspaceId === data?.workspace.id && (
        <div className="quarantine-outcome" role="status">
          <strong>
            {mcpResult.status === 'configured'
              ? mcpResult.proxy?.toolApproval
                ? 'Strict MCP wrapper with tool review configured'
                : 'Strict MCP wrapper configured'
              : mcpResult.status === 'restored'
                ? 'Original MCP registration restored'
                : 'One MCP registration removed from its configuration source'}
          </strong>
          <p>Restart or reconnect the client. Already connected servers may remain available.</p>
          <Link
            className="inline-link"
            href={mcpContainmentHref(mcpResult.recordId, mcpResult.workspaceId)}
          >
            Recheck or restore
          </Link>
          {mcpResult.status === 'configured' && mcpResult.proxy?.toolApproval && (
            <Link className="inline-link" href="/skills/mcp/contracts/">
              Review tool contracts <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
      {quarantined && quarantined.workspaceId === data?.workspace.id && (
        <div className="quarantine-outcome" role="status">
          <strong>Captured folder moved out of discovery</strong>
          <p>Start a fresh agent session. Existing loaded instructions remain in conversations.</p>
          <Link
            className="inline-link"
            href={quarantineHref(quarantined.recordId, quarantined.workspaceId)}
          >
            Recheck or restore
          </Link>
        </div>
      )}

      {error && (
        <div role="alert" className="control-error">
          {error}
          {data ? ' Showing the last successful inventory.' : ''}
        </div>
      )}
      {data?.baseline.status === 'invalid' && (
        <p className="control-error" role="alert">
          Reviewed baseline unavailable. Current inspection remains available; recording reviews is
          unavailable.
        </p>
      )}
      {localAccess &&
        (location.invalid || (data && location.id && (!candidate || changedVersion))) && (
          <p className="control-error" role="status" ref={selectionNotice} tabIndex={-1}>
            {location.invalid
              ? 'This artifact link is invalid.'
              : !sameWorkspace
                ? 'This link belongs to another workspace.'
                : changedVersion
                  ? 'The linked version is no longer current. Review the new version separately.'
                  : 'This artifact is no longer available in the inventory.'}
            {changedVersion && candidate && (
              <button
                className="inline-link"
                ref={currentVersionButton}
                onClick={(event) => select(candidate, event.currentTarget)}
              >
                Open current version
              </button>
            )}
            <button className="inline-link" onClick={() => select(null)}>
              Clear selection
            </button>
          </p>
        )}
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect the local engine"
            description="Open your private server link to inspect installed skills and MCP configurations."
          />
          <div className="panel-body">
            <Link href="/settings/" className="button">
              Connection settings <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </Panel>
      ) : (
        <>
          {data && items.length === 0 ? (
            <p className="inventory-summary-empty">
              No skills or MCP servers were found in this workspace or your user folders yet.
            </p>
          ) : (
            <div className="inventory-summary">
              <div>
                <span>Discovered items</span>
                <strong>{data ? items.length : '—'}</strong>
              </div>
              <div>
                <span>Awaiting review</span>
                <strong>{data ? pending : '—'}</strong>
              </div>
              <div>
                <span>Changed since review</span>
                <strong>{data ? changed : '—'}</strong>
              </div>
            </div>
          )}
          <Panel
            title={data ? data.workspace.label : 'Local workspace'}
            actions={
              data ? (
                <span className="control-meta">
                  <Folder size={14} aria-hidden="true" />
                  Workspace + user scope
                </span>
              ) : undefined
            }
          >
            <div className="inventory-toolbar">
              <div className="filter-tabs" aria-label="Artifact type">
                {(['all', 'skill', 'mcp'] as const).map((value) => (
                  <button
                    key={value}
                    className={value === kind ? 'is-active' : ''}
                    aria-pressed={value === kind}
                    onClick={() => setKind(value)}
                  >
                    {value === 'all' ? 'All' : value === 'skill' ? 'Skills' : 'MCP servers'}
                  </button>
                ))}
              </div>
              <label className="inventory-view">
                <span>View</span>
                <select
                  className="select-field"
                  aria-label="Inventory view"
                  value={view}
                  onChange={(event) => setView(event.target.value as InventoryView)}
                >
                  <option value="all">All items</option>
                  <option value="signals">Matched signals</option>
                  <option value="changes">Changes</option>
                  <option value="unreviewed">New</option>
                  <option value="incomplete">Incomplete</option>
                </select>
              </label>
              <label className="inventory-search">
                <Search size={16} aria-hidden="true" />
                <input
                  name="inventory-search"
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search inventory…"
                  aria-label="Search inventory"
                />
              </label>
            </div>
            {loading && !data ? (
              <div className="control-empty" role="status">
                <LoaderCircle size={28} className="spin" aria-hidden="true" />
                <p>Inspecting local configuration and skill files…</p>
              </div>
            ) : data && visible.length === 0 ? (
              <EmptyState
                title={
                  query
                    ? 'No matching items'
                    : view !== 'all'
                      ? 'No items in this view'
                      : 'No supported items found'
                }
                description={
                  query
                    ? 'Try another name or agent.'
                    : view !== 'all'
                      ? 'Choose another view or refresh inventory.'
                      : 'Supported roots were inspected. Coverage limits are listed below.'
                }
              />
            ) : (
              <div
                className="table-wrap"
                role="region"
                aria-label="Installed skills and MCP servers"
                tabIndex={0}
              >
                <table className="data-table inventory-table">
                  <thead>
                    <tr>
                      <th>Artifact</th>
                      <th>Source</th>
                      <th>Scope</th>
                      <th>Changes</th>
                      <th>Inspection</th>
                      <th aria-label="Open review" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <button
                            className="inventory-name"
                            aria-label={`${item.name} · ${inventorySourceLabel(item)}`}
                            onClick={(event) => select(item, event.currentTarget)}
                          >
                            {item.kind === 'skill' ? (
                              <FileCode2 size={18} aria-hidden="true" />
                            ) : (
                              <Server size={18} aria-hidden="true" />
                            )}
                            <span>
                              <strong>{item.name}</strong>
                              <small>{item.kind === 'skill' ? 'Skill' : 'MCP server'}</small>
                            </span>
                          </button>
                        </td>
                        <td>
                          <InventorySource item={item} />
                        </td>
                        <td>{item.scope === 'project' ? 'Workspace' : 'User'}</td>
                        <td>
                          <InventoryBadge item={item} />
                        </td>
                        <td>
                          {item.scan.status === 'incomplete' ? (
                            <Badge tone="orange">Incomplete</Badge>
                          ) : item.scan.findings ? (
                            <Badge tone={item.scan.status === 'suspect' ? 'orange' : 'muted'}>
                              {item.scan.findings} signals
                            </Badge>
                          ) : item.kind === 'mcp' ? (
                            <span className="muted">
                              {item.mcp?.wrapper === 'configured'
                                ? 'Wrapper configured'
                                : 'No wrapper'}
                            </span>
                          ) : (
                            <span className="muted">
                              {item.scan.status === 'not-scanned'
                                ? 'Not scanned'
                                : item.capabilities?.length
                                  ? `${item.capabilities.length} capabilities`
                                  : 'No signals'}
                            </span>
                          )}
                          <InventorySignalBadge decision={item.signalDecision} />
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Review ${item.name} · ${inventorySourceLabel(item)}`}
                            onClick={(event) => select(item, event.currentTarget)}
                          >
                            <ArrowRight size={16} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {data && (
            <details className="panel" id="inventory-coverage" open={view === 'incomplete'}>
              <summary className="panel-heading">
                <h2>Coverage & freshness</h2>
                <Badge tone={data.gaps.length ? 'orange' : 'muted'}>
                  {data.gaps.length ? `${data.gaps.length} gaps` : 'Static inspection'}
                </Badge>
              </summary>
              <div className="panel-body">
                <p className="control-meta">
                  Inspected {new Date(data.generatedAt).toLocaleString('en-GB')} ·{' '}
                  {data.baseline.status === 'ready'
                    ? 'Reviewed baseline available'
                    : data.baseline.status === 'invalid'
                      ? 'Baseline could not be read'
                      : 'No reviewed baseline yet'}
                </p>
                <InventorySourceCoverage sources={data.skillSources} />
                {data.signalDecisions?.status === 'unavailable' && (
                  <p className="control-error" role="status">
                    Saved signal decisions could not be read. Matched signals remain visible.
                  </p>
                )}
                {data.gaps.map((gap, i) => (
                  <p className="control-meta" key={i}>
                    {INVENTORY_AGENTS[gap.agent] ?? gap.agent} · {gap.scope} ·{' '}
                    {gap.code.replaceAll('-', ' ')}
                  </p>
                ))}
                {data.limitations.map((limit) => (
                  <p className="control-meta" key={limit}>
                    {limit}
                  </p>
                ))}
              </div>
            </details>
          )}
        </>
      )}
      <InventoryReview
        reviewNeedsRecheck={needsRecheck}
        selected={selected}
        workspaceId={data?.workspace.id ?? null}
        href={inventoryHref(
          selected?.id ?? null,
          data?.workspace.id ?? null,
          selected?.sha256 ?? null,
          kind,
          view,
        )}
        reviewing={reviewing}
        loading={loading}
        baselineInvalid={data?.baseline.status === 'invalid'}
        error={error}
        onClose={() => select(null)}
        onReview={review}
        onQuarantined={(value) => {
          setQuarantined(value);
          select(null);
          void refresh();
        }}
        onMcpCompleted={(value) => {
          setMcpResult(value);
          select(null);
          void refresh();
        }}
        onNeedsRecheck={() => void refresh()}
        onRefreshInventory={() => void refresh()}
        onReturnFocus={() => {
          if (location.id && (!candidate || changedVersion))
            (currentVersionButton.current ?? selectionNotice.current)?.focus();
          else if (returnFocus.current?.isConnected) returnFocus.current.focus();
          else if (refreshButton.current && !refreshButton.current.disabled)
            refreshButton.current.focus();
          else page.current?.focus();
          returnFocus.current = null;
        }}
      />
    </div>
  );
}
