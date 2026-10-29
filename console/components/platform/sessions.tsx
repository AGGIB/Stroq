'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Info, Search } from 'lucide-react';
import { sessionFor } from '@/lib/platform';
import { usePlatform } from '@/components/platform-provider';
import { Badge, EmptyState, ExportButton, PageHeading, Panel } from '@/components/platform-ui';

function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-field">
      <Search size={16} aria-hidden="true" />
      <input
        name="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function SessionsPage() {
  const { calls, source, generatedAt } = usePlatform();
  const [query, setQuery] = useState('');
  const sessions = useMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        name: string;
        project: string;
        agent: string;
        total: number;
        blocks: number;
        review: number;
        last: string;
      }
    >();
    for (const call of calls) {
      const session = sessionFor(call);
      const current = groups.get(session.id);
      const last = `${call.date} ${call.time}`;
      groups.set(session.id, {
        ...session,
        agent: current && current.agent !== call.agent ? 'Multiple agents' : call.agent,
        total: (current?.total ?? 0) + 1,
        blocks: (current?.blocks ?? 0) + Number(call.decision === 'block'),
        review:
          (current?.review ?? 0) + Number(call.decision === 'ask' || call.decision === 'flag'),
        last: current && current.last > last ? current.last : last,
      });
    }
    return [...groups.values()].sort((a, b) => b.last.localeCompare(a.last));
  }, [calls]);
  const visible = sessions.filter((session) =>
    `${session.name} ${session.project} ${session.agent} ${session.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="page-stack">
      <PageHeading
        title="Sessions"
        actions={
          <ExportButton
            data={{ source, generatedAt, sessions: visible }}
            filename="stroq-sessions.json"
          />
        }
      />
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">Session groups</span>
          <strong className="stat-value">{sessions.length.toString().padStart(2, '0')}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">Events</span>
          <strong className="stat-value">{calls.length.toLocaleString()}</strong>
        </div>
        <div className="stat-card">
          <span className="stat-label">With policy signals</span>
          <strong className="stat-value">
            {sessions
              .filter((session) => session.blocks || session.review)
              .length.toString()
              .padStart(2, '0')}
          </strong>
        </div>
      </div>
      <Panel
        title="History"
        subtitle={`${visible.length} groups`}
        actions={<SearchField value={query} onChange={setQuery} placeholder="Search sessions…" />}
      >
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Session history table">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session / project</th>
                <th>Agent</th>
                <th>Events</th>
                <th>Interventions</th>
                <th>Last event · UTC</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {visible.map((session) => (
                <tr key={session.id}>
                  <td>
                    <Link
                      className="table-main session-title"
                      href={`/activity/?session=${encodeURIComponent(session.id)}`}
                    >
                      {session.name}
                    </Link>
                    <div className="table-sub mono">{session.project}</div>
                  </td>
                  <td>{session.agent}</td>
                  <td className="mono">{session.total}</td>
                  <td>
                    {session.blocks ? (
                      <Badge tone="red">
                        {session.blocks} deny {session.blocks === 1 ? 'decision' : 'decisions'}
                      </Badge>
                    ) : session.review ? (
                      <Badge tone="orange">{session.review} to review</Badge>
                    ) : (
                      <Badge tone="muted">No intervention</Badge>
                    )}
                  </td>
                  <td className="mono muted">{session.last}</td>
                  <td>
                    <Link
                      className="icon-button"
                      href={`/activity/?session=${encodeURIComponent(session.id)}`}
                      aria-label={`Open ${session.name}`}
                    >
                      <ArrowRight aria-hidden="true" size={16} />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <EmptyState
            title="No matching sessions"
            description={
              query ? 'Try another search.' : 'Connect your local source to load sessions.'
            }
          />
        )}
      </Panel>
      {sessions.some((session) => session.id === 'unattributed') && (
        <p className="info-note">
          <Info aria-hidden="true" size={18} />
          Unattributed events have no session ID.
        </p>
      )}
    </div>
  );
}
