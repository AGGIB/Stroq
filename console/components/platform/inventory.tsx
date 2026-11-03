'use client';
import { useMemo, useRef, useState, type ReactNode } from 'react';
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
import { QuarantineHistory } from './skill-quarantine';
import { RegistrationHistory } from './mcp-containment';
import { ToolVersions } from './mcp-tool-contracts';
import { CheckText } from './skills';
import { useScrollToHash } from '@/hooks/use-scroll-to-hash';
import { skillsPart, skillsPartHref, type SkillsPart } from '@/lib/skills-navigation';
import { INVENTORY_AGENTS, type InventoryItem } from '@/lib/inventory';
import {
  InventorySource,
  InventorySourceCoverage,
  inventorySourceLabel,
  inventorySourceSearchText,
} from './inventory-source';
import { InventorySignalBadge } from './inventory-signal-controls';
import { McpGovernanceControls } from './mcp-governance';

/** One of the parts under the list: closed until it is asked for, and reading nothing until then. */
function Part({ part, title, children }: { part: SkillsPart; title: string; children: ReactNode }) {
  const named = skillsPart(useSearchParams()) === part;
  const [open, setOpen] = useState(named);
  return (
    <details
      className="skills-part-wrap"
      open={open || undefined}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{title}</summary>
      {open ? children : null}
    </details>
  );
}

/** The undo of each change, the tool versions to approve, and the check of a skill's text. */
function SkillsParts() {
  useScrollToHash(true);
  return (
    <div className="skills-parts">
      <Part part="quarantine" title="Undo: skills moved aside">
        <QuarantineHistory />
      </Part>
      <Part part="registrations" title="Undo: MCP changes, and pause or resume">
        <RegistrationHistory />
      </Part>
      <Part part="tools" title="Approve MCP tool versions">
        <ToolVersions />
      </Part>
      <Part part="check" title="Check a skill’s text">
        <CheckText />
      </Part>
    </div>
  );
}

/** Every skill and MCP server by agent, what changed since you last looked, and the changes you can make. */
export function SkillsMcpPage() {
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
  const byAgent = useMemo(() => {
    const groups = new Map<string, InventoryItem[]>();
    for (const item of visible) groups.set(item.agent, [...(groups.get(item.agent) ?? []), item]);
    return [...groups.entries()]
      .sort(([a], [b]) => (INVENTORY_AGENTS[a] ?? a).localeCompare(INVENTORY_AGENTS[b] ?? b))
      .map(([agent, rows]) => ({ agent, rows }));
  }, [visible]);
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
        description="Every skill and MCP server your agents can load, by agent: where it came from, what the rules matched in it, and what changed since you last looked. Checked when you open this screen, and again when you ask."
        actions={
          <>
            <McpGovernanceControls />
            <button
              className="button"
              ref={refreshButton}
              disabled={!localAccess || loading || reviewing}
              onClick={() => void refresh()}
            >
              <RefreshCw size={16} className={loading ? 'spin' : undefined} aria-hidden="true" />
              {loading ? 'Checking…' : 'Check again'}
            </button>
          </>
        }
      />
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
            Undo this change
          </Link>
          {mcpResult.status === 'configured' && mcpResult.proxy?.toolApproval && (
            <Link className="inline-link" href={skillsPartHref('tools')}>
              Review tool versions <ArrowRight size={14} aria-hidden="true" />
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
            Undo this change
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
          <p className="panel-body control-meta">
            Not connected to Stroq on this machine. Run <code>npx @stroq/cli console</code> to open
            this page with your data.
          </p>
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
                <span>Changed since you looked</span>
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
              <div className="skills-agents">
                {byAgent.map(({ agent, rows }) => (
                  <section
                    key={agent}
                    className="skills-agent"
                    aria-label={`${INVENTORY_AGENTS[agent] ?? agent}: skills and MCP servers`}
                  >
                    <h3>
                      {INVENTORY_AGENTS[agent] ?? agent}
                      <Badge tone="muted">{rows.length}</Badge>
                    </h3>
                    <div className="table-wrap" tabIndex={0}>
                      <table className="data-table inventory-table">
                        <thead>
                          <tr>
                            <th>What</th>
                            <th>Where from</th>
                            <th>Rule hits</th>
                            <th>Since you looked</th>
                            <th aria-label="Open" />
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((item) => (
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
                                <small className="muted">
                                  {item.scope === 'project' ? 'Workspace' : 'User'}
                                </small>
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
                                <InventoryBadge item={item} />
                              </td>
                              <td>
                                <button
                                  className="icon-button"
                                  aria-label={`Review ${item.name} · ${inventorySourceLabel(item)}`}
                                  onClick={(event) => select(item, event.currentTarget)}
                                >
                                  <ArrowRight size={16} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ))}
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
      {localAccess ? <SkillsParts /> : null}
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
