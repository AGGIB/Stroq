'use client';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Info,
  Search,
  ShieldBan,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { usePlatform } from './platform-provider';
import { Badge, EmptyState, ExportButton, PageHeading, Panel } from './platform-ui';
import { EventTable } from './platform-overview';
import { NotConnected } from './not-connected';
import { DECISIONS, inRange, sessionFor } from '@/lib/platform';
import type { Decision } from '@/lib/status';
import { activityEventSelection, activityFindingHref } from '@/lib/activity-navigation';
const FILTERS = ['all', 'review', 'block', 'ask', 'flag', 'allow', 'nj'] as const;
export function ActivityPage() {
  const { calls, generatedAt, source } = usePlatform(),
    params = useSearchParams();
  const query = params.get('q') ?? '',
    agent = params.get('agent') ?? 'all',
    decision = params.get('decision') ?? 'all',
    session = params.get('session'),
    days = Number(params.get('days') ?? 30),
    page = Math.max(1, Number(params.get('page')) || 1);
  if (source === 'none') return <NotConnected title="Activity" />;
  const scoped = inRange(calls, [1, 7, 30].includes(days) ? days : 30, generatedAt);
  const visible = scoped.filter(
    (c) =>
      (decision === 'all' ||
        !FILTERS.includes(decision as (typeof FILTERS)[number]) ||
        (decision === 'review'
          ? c.decision === 'ask' || c.decision === 'flag'
          : c.decision === decision)) &&
      (agent === 'all' || c.agent === agent) &&
      (!session || sessionFor(c).id === session) &&
      `${c.label} ${c.raw} ${c.rule ?? ''} ${c.agent}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(visible.length / 20)),
    current = Math.min(page, pages),
    shown = visible.slice((current - 1) * 20, current * 20);
  function update(key: string, value: string) {
    const p = new URLSearchParams(params.toString());
    if (value === 'all' || value === '') p.delete(key);
    else p.set(key, value);
    if (key !== 'page') p.delete('page');
    window.history.replaceState(null, '', `/activity/${p.size ? `?${p}` : ''}`);
  }
  const names = Array.from(new Set(calls.map((c) => c.agent)));
  return (
    <div className="page-stack">
      <PageHeading
        title="Activity"
        actions={
          <ExportButton
            data={{ source, generatedAt, filters: Object.fromEntries(params), calls: visible }}
            filename="stroq-activity.json"
            label="Export events"
          />
        }
      />
      <details className="context-note">
        <summary>
          <Info size={14} aria-hidden="true" /> About decisions
        </summary>
        <p>
          A deny decision records policy intent. Check agent coverage to verify that the host can
          block actions.
        </p>
      </details>
      {session ? (
        <div className="activity-summary">
          Session <code>{session}</code>
          <button className="button small" onClick={() => update('session', '')}>
            Clear session
          </button>
        </div>
      ) : null}
      <Panel>
        <div className="toolbar">
          <div className="filter-tabs" aria-label="Decision filters">
            {FILTERS.map((f) => (
              <button
                key={f}
                aria-pressed={decision === f}
                className={decision === f ? 'is-active' : ''}
                onClick={() => update('decision', f)}
              >
                {f === 'all' ? 'All events' : f === 'review' ? 'Needs review' : DECISIONS[f].label}
                <span>
                  {f === 'all'
                    ? scoped.length
                    : scoped.filter((c) =>
                        f === 'review'
                          ? c.decision === 'ask' || c.decision === 'flag'
                          : c.decision === f,
                      ).length}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar">
          <label className="search-field">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search events"
              name="events-search"
              placeholder="Search events, commands, rules…"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => update('q', e.target.value)}
            />
          </label>
          <select
            aria-label="Filter by agent"
            className="select-field"
            value={agent}
            onChange={(e) => update('agent', e.target.value)}
          >
            <option value="all">All agents</option>
            {names.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <select
            aria-label="Filter by time"
            className="select-field"
            value={days}
            onChange={(e) => update('days', e.target.value)}
          >
            <option value={1}>Today (UTC)</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
          {params.size > 0 ? (
            <button
              className="button subtle small"
              onClick={() => window.history.replaceState(null, '', '/activity/')}
            >
              Reset filters
            </button>
          ) : null}
        </div>
        <EventTable calls={shown} />
        <div className="pagination">
          <span aria-live="polite">
            {visible.length === 0
              ? '0 events'
              : `${(current - 1) * 20 + 1}–${Math.min(current * 20, visible.length)} of ${visible.length} events`}
          </span>
          <div>
            <button
              className="icon-button"
              aria-label="Previous page"
              disabled={current <= 1}
              onClick={() => update('page', String(current - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>
              {current} / {pages}
            </span>
            <button
              className="icon-button"
              aria-label="Next page"
              disabled={current >= pages}
              onClick={() => update('page', String(current + 1))}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
export function InvestigationPage() {
  const { calls, source, loading } = usePlatform(),
    params = useSearchParams(),
    id = params.get('id') ?? '',
    selection = activityEventSelection(params, calls, source),
    call = selection.call;
  if (source === 'none') return <NotConnected title="Event" />;
  if (!call)
    return (
      <div className="page-stack">
        <Link className="event-back" href="/activity/">
          <ArrowLeft size={14} />
          Back to activity
        </Link>
        <EmptyState
          title={
            selection.error === 'invalid'
              ? 'Invalid event link'
              : selection.error === 'stale'
                ? 'Recorded event unavailable'
                : loading
                  ? 'Loading local event…'
                  : 'Event not found'
          }
          description={
            selection.error === 'stale'
              ? 'The selected evidence is no longer available in the current journal window.'
              : 'Return to activity or select the appropriate workspace.'
          }
        />
      </div>
    );
  const status = DECISIONS[call.decision],
    session = sessionFor(call);
  const findingHref = activityFindingHref(call, source),
    localFinding = source === 'local' && ['block', 'ask', 'flag'].includes(call.decision);
  return (
    <div className="page-stack">
      <Link className="event-back" href="/activity/">
        <ArrowLeft size={14} />
        Back to activity
      </Link>
      <div className="page-heading">
        <div className="event-title-row">
          <span>
            <ShieldBan size={25} aria-hidden="true" />
          </span>
          <div>
            <h1>{call.label}</h1>
            <p>
              Recorded event · {id} · {call.date} at {call.time} UTC
            </p>
            {selection.binding === 'current-window' && (
              <p className="risk-note">Legacy link · current journal window</p>
            )}
            {localFinding && !findingHref && (
              <p className="risk-note">Exact finding link unavailable.</p>
            )}
          </div>
        </div>
        <div className="event-actions">
          <Badge tone={status.tone}>{status.label}</Badge>
          {findingHref ? (
            <Link className="button primary" href={findingHref}>
              Open investigation <ArrowRight size={14} />
            </Link>
          ) : localFinding ? (
            <Link className="button subtle" href="/incidents/?status=all">
              Open Investigations <ArrowRight size={14} />
            </Link>
          ) : source === 'local' ? (
            <Link href="/agents/" className="button subtle">
              Check coverage <ArrowRight size={14} />
            </Link>
          ) : null}
          <ExportButton
            data={{
              schema: 'stroq-activity-event-export/2',
              source,
              call,
              session,
              binding: selection.binding,
            }}
            filename={`stroq-event-${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`}
            label="Export event"
          />
        </div>
      </div>
      <div className="detail-grid">
        <div className="page-stack">
          <Panel title="Evidence" actions={<Badge>Values redacted</Badge>}>
            <div className="evidence-section">
              <h3>Recorded action</h3>
              <pre className="evidence-code">
                <code>{call.raw}</code>
              </pre>
              <p className="evidence-description">Command details withheld from this snapshot.</p>
            </div>
            <div className="evidence-section">
              <h3>Decision reason</h3>
              <p className="evidence-description">
                {call.reason ?? 'No additional decision reason is available in this record.'}
              </p>
            </div>
          </Panel>
        </div>
        <div className="page-stack">
          <Panel title="Event details">
            <dl className="property-list panel-body">
              <div>
                <dt>Decision</dt>
                <dd>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{call.agent}</dd>
              </div>
              <div>
                <dt>Project</dt>
                <dd>{session.project}</dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>
                  <Link
                    className="inline-link mono"
                    href={`/activity/?session=${encodeURIComponent(session.id)}`}
                  >
                    {session.id}
                    <ArrowRight size={12} />
                  </Link>
                </dd>
              </div>
              <div>
                <dt>Rule</dt>
                <dd className="mono">{call.rule ?? 'Not exposed'}</dd>
              </div>
              <div>
                <dt>Data source</dt>
                <dd>Local journal</dd>
              </div>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}
