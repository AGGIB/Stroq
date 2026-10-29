'use client';
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Cpu,
  KeyRound,
  Shield,
  ShieldBan,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode, type CSSProperties } from 'react';
import { usePlatform } from './platform-provider';
import { AgentGlyph, Badge, ExportButton, PageHeading, Panel, EmptyState } from './platform-ui';
import { DECISIONS, inRange, sessionFor } from '@/lib/platform';
import type { ToolCall } from '@/lib/data';
import { activityEventHref } from '@/lib/activity-navigation';

export function Overview() {
  const { calls, agents, keys, source, generatedAt } = usePlatform();
  const [days, setDays] = useState(7);
  const scoped = inRange(calls, days, generatedAt),
    denied = scoped.filter((c) => c.decision === 'block'),
    review = scoped.filter((c) => c.decision === 'ask' || c.decision === 'flag'),
    verified = agents.filter((a) => a.state === 'ok');
  const findings = keys.filter((k) => k.needsYou),
    activity = scoped.filter((c) => c.decision !== 'allow').slice(0, 5);
  return (
    <div className="page-stack">
      <PageHeading
        title="Security overview"
        actions={
          <>
            <label className="period-select">
              <CalendarDays size={15} aria-hidden="true" />
              <select
                aria-label="Time range"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={1}>Today (UTC)</option>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </label>
            <ExportButton data={{ source, generatedAt, days, calls: scoped, agents, keys }} />
          </>
        }
      />
      <section className="metrics-row" aria-label="Workspace metrics">
        <Metric
          title="Events evaluated"
          value={scoped.filter((c) => c.decision !== 'nj').length}
          icon={<Activity size={17} />}
          tone="neutral"
        />
        <Metric
          title="Deny decisions"
          value={denied.length}
          icon={<ShieldBan size={17} />}
          tone="red"
          href="/activity/?decision=block"
        />
        <Metric
          title="Needs review"
          value={review.length}
          icon={<CircleAlert size={17} />}
          tone="orange"
          href="/activity/?decision=review"
        />
        <Metric
          title="Agents verified"
          value={agents.length === 0 ? 'None seen' : `${verified.length} / ${agents.length}`}
          icon={<Cpu size={17} />}
          tone="green"
          href="/agents/"
        />
      </section>
      <div className="overview-grid">
        <Panel title="Activity" className="activity-chart-panel">
          <ActivityChart calls={scoped} days={days} anchor={generatedAt} />
          <div className="chart-legend">
            <span>
              <i className="legend-allow" />
              Allow
            </span>
            <span>
              <i className="legend-ask" />
              Ask / flagged
            </span>
            <span>
              <i className="legend-deny" />
              Deny
            </span>
          </div>
        </Panel>
        <Panel
          title="Agent coverage"
          actions={
            <Link href="/agents/" className="inline-link">
              View all
              <ArrowUpRight size={14} />
            </Link>
          }
          className="coverage-panel"
        >
          <div className="coverage-summary">
            <div
              className="coverage-ring"
              style={
                {
                  '--coverage': `${agents.length ? (verified.length / agents.length) * 100 : 0}%`,
                } as CSSProperties
              }
            >
              <Shield size={22} aria-hidden="true" />
            </div>
            <div>
              <strong>
                {verified.length}
                <span> / {agents.length}</span>
              </strong>
              <p>blocking verified</p>
            </div>
          </div>
          <div className="coverage-list">
            {agents.map((a) => (
              <Link href={`/agents/#${a.id}`} key={a.id}>
                <AgentGlyph name={a.name} />
                <span>{a.name}</span>
                <span
                  className={`coverage-state ${a.state === 'ok' ? 'green' : a.state === 'unver' ? 'orange' : 'muted'}`}
                >
                  {a.state === 'ok' ? <Check size={12} /> : <span className="small-dot" />}
                  {a.state === 'ok'
                    ? 'Verified'
                    : a.state === 'unver'
                      ? 'Unverified'
                      : a.state === 'watch'
                        ? 'Observe only'
                        : 'Not connected'}
                </span>
              </Link>
            ))}
          </div>
          {agents.length === 0 ? (
            <p className="panel-body muted">No supported agent observations were found.</p>
          ) : null}
        </Panel>
      </div>
      <Panel
        title="Attention required"
        actions={
          <span className="count-pill">
            {findings.length + (agents.some((a) => a.state === 'unver') ? 1 : 0)}
          </span>
        }
      >
        <div className="attention-grid">
          {findings.map((k, i) => (
            <Link
              href={`/keys/#${k.id}`}
              className={`attention-card ${i === 0 ? 'critical' : ''}`}
              key={k.id}
            >
              <div className="attention-top">
                <span className="signal-icon">
                  <KeyRound size={16} />
                </span>
                <Badge tone={i === 0 ? 'red' : 'orange'}>
                  {k.outcome === 'sent' ? 'Exposed' : 'Investigate'}
                </Badge>
                <ArrowUpRight size={15} />
              </div>
              <h3 className="finding-name">{k.name}</h3>
              <p>
                {k.destination} · {k.when}
              </p>
            </Link>
          ))}
          {agents.some((a) => a.state === 'unver') ? (
            <Link href="/agents/" className="attention-card">
              <div className="attention-top">
                <span className="signal-icon">
                  <Cpu size={16} />
                </span>
                <Badge tone="orange">Coverage gap</Badge>
                <ArrowUpRight size={15} />
              </div>
              <h3>
                {agents
                  .filter((a) => a.state === 'unver')
                  .map((a) => a.name)
                  .join(', ')}
              </h3>
              <p>Blocking not verified</p>
            </Link>
          ) : null}
          {findings.length === 0 && !agents.some((a) => a.state === 'unver') ? (
            <div className="panel-body muted">No findings available in this snapshot.</div>
          ) : null}
        </div>
      </Panel>
      <Panel
        title="Recent events"
        actions={
          <Link href="/activity/" className="inline-link">
            All activity
            <ArrowRight size={14} />
          </Link>
        }
      >
        <EventTable calls={activity} />
      </Panel>
    </div>
  );
}
function Metric({
  title,
  value,
  icon,
  tone,
  href,
}: {
  title: string;
  value: number | string;
  icon: ReactNode;
  tone: string;
  href?: string;
}) {
  const content = (
    <>
      <div className="metric-label">
        {title}
        <span className={tone}>{icon}</span>
      </div>
      <div className="metric-value">
        {typeof value === 'number' ? value.toLocaleString('en-US') : value}
        {href ? <ArrowUpRight className="metric-arrow" size={17} aria-hidden="true" /> : null}
      </div>
    </>
  );
  return href ? (
    <Link href={href} className="metric-card">
      {content}
    </Link>
  ) : (
    <div className="metric-card">{content}</div>
  );
}
function ActivityChart({
  calls,
  days,
  anchor,
}: {
  calls: readonly ToolCall[];
  days: number;
  anchor: string;
}) {
  const count = days === 1 ? 12 : days,
    end = new Date(`${anchor.slice(0, 10)}T00:00:00Z`),
    hourly = days === 1;
  const buckets = Array.from({ length: count }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (count - i - 1));
    const date = d.toISOString().slice(0, 10);
    const c = calls.filter((c) =>
      hourly ? Math.floor(Number(c.time.slice(0, 2)) / 2) === i : c.date === date,
    );
    return {
      label: hourly
        ? `${String(i * 2).padStart(2, '0')}:00`
        : new Intl.DateTimeFormat('en-US', {
            day: 'numeric',
            month: 'short',
            timeZone: 'UTC',
          }).format(d),
      allow: c.filter((x) => x.decision === 'allow').length,
      review: c.filter((x) => x.decision === 'ask' || x.decision === 'flag').length,
      deny: c.filter((x) => x.decision === 'block').length,
    };
  });
  const max = Math.max(1, ...buckets.map((b) => b.allow + b.review + b.deny));
  return (
    <div className="activity-chart">
      <div className="chart-axis">
        {[1, 0.75, 0.5, 0.25, 0].map((t) => (
          <span key={t}>{Math.ceil(max * t)}</span>
        ))}
      </div>
      <div className="chart-plot">
        <div className="chart-gridlines">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        <div className="chart-columns" style={{ gap: count > 12 ? '3px' : '7%' }}>
          {buckets.map((b, i) => (
            <div
              className="chart-column"
              key={i}
              tabIndex={0}
              aria-label={`${b.label}: ${b.allow} allow, ${b.review} review, ${b.deny} deny`}
            >
              <div className="chart-bar-space">
                <div
                  className="chart-bar"
                  style={{ height: `${((b.allow + b.review + b.deny) / max) * 100}%` }}
                >
                  <div className="bar-deny" style={{ flex: b.deny }} />
                  <div className="bar-review" style={{ flex: b.review }} />
                  <div className="bar-allow" style={{ flex: b.allow }} />
                </div>
              </div>
              <span className="chart-date">{count <= 12 || i % 5 === 0 ? b.label : ''}</span>
              <div className="chart-tooltip">
                {b.label}
                <b>{b.allow + b.review + b.deny} decisions</b>
                {b.deny} deny · {b.review} review
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
export function EventTable({ calls }: { calls: readonly ToolCall[] }) {
  return calls.length === 0 ? (
    <EmptyState
      title="No events in this view"
      description="Try another time range or connect a local journal."
    />
  ) : (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Security events table">
      <table className="data-table events-table">
        <thead>
          <tr>
            <th>Decision</th>
            <th>Event</th>
            <th>Agent</th>
            <th>
              Time <ArrowDownRight size={11} />
            </th>
            <th>
              <span className="sr-only">Open</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td>
                <Badge tone={DECISIONS[c.decision].tone}>{DECISIONS[c.decision].label}</Badge>
              </td>
              <td>
                <Link href={activityEventHref(c)} className="table-main">
                  {c.label}
                </Link>
                <span className="table-sub mono">{c.rule ?? sessionFor(c).project}</span>
              </td>
              <td>
                <span className="table-agent">
                  <AgentGlyph name={c.agent} />
                  {c.agent}
                </span>
              </td>
              <td className="time-cell">
                <time dateTime={`${c.date}T${c.time}Z`}>{c.time.slice(0, 5)}</time>
                <span>
                  {new Intl.DateTimeFormat('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'UTC',
                  }).format(new Date(`${c.date}T00:00:00Z`))}
                </span>
              </td>
              <td>
                <Link
                  className="table-arrow"
                  href={activityEventHref(c)}
                  aria-label={`Investigate ${c.label}`}
                >
                  <ChevronRight size={15} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
