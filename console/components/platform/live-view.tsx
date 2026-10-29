'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, BellOff, CircleAlert, Pause, Play, RefreshCw } from 'lucide-react';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { useJournalLive, type LiveRow, type LiveState } from './use-journal-live';
import { LiveReceipt } from './live-receipt';
import { describeRow, type JournalSummary } from '@/lib/journal-view';

type Filter = 'all' | 'attention';

const STATE_WORDS: Readonly<Record<LiveState, string>> = {
  connecting: 'Connecting to your journal',
  live: 'Watching your journal',
  paused: 'Paused',
  missing: 'No journal yet',
  refused: 'Journal not readable',
  error: 'Not updating',
};

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 90) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function Counts({ summary }: { summary: JournalSummary | null }) {
  const items = [
    { key: 'allow', label: 'Allowed', tone: 'green', value: summary?.counts.allow },
    { key: 'ask', label: 'Asked you', tone: 'orange', value: summary?.counts.ask },
    { key: 'deny', label: 'Denied', tone: 'red', value: summary?.counts.deny },
    { key: 'suspect', label: 'Flagged', tone: 'orange', value: summary?.counts.suspect },
  ] as const;
  return (
    <ul className="live-counts" aria-label="Recorded actions by decision">
      {items.map((item) => (
        <li key={item.key} className={`live-count ${item.tone}`}>
          <span className="live-count-number">
            {item.value === undefined ? '–' : item.value.toLocaleString()}
          </span>
          <span className="live-count-label">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ entry }: { entry: LiveRow }) {
  const { row } = entry;
  const words = describeRow(row);
  return (
    <li className={`live-row ${entry.fresh ? 'is-fresh' : ''}`}>
      <time className="live-time mono" dateTime={row.at}>
        {clock(row.at)}
      </time>
      <span className="live-verdict">
        <Badge tone={words.tone}>{words.verdict}</Badge>
      </span>
      <span className="live-what">
        <strong>{words.title}</strong>
        <span className="live-detail">{words.detail}</span>
      </span>
    </li>
  );
}

export function LivePage() {
  const {
    localAccess,
    rows,
    summary,
    state,
    error,
    gap,
    paused,
    polledAt,
    togglePause,
    retry,
    notify,
    setNotifications,
  } = useJournalLive();
  const [filter, setFilter] = useState<Filter>('all');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const shown =
    filter === 'all'
      ? rows
      : rows.filter(
          ({ row }) => row.decision === 'deny' || row.decision === 'ask' || row.scan === 'suspect',
        );
  const newest = rows[0]?.row;
  const announce =
    newest && (newest.decision === 'deny' || newest.decision === 'ask' || newest.scan === 'suspect')
      ? `${describeRow(newest).verdict}: ${describeRow(newest).title}`
      : '';

  return (
    <div className="page-stack" role="region" aria-label="Live">
      <PageHeading
        title="Live"
        description="What your agents are doing: recorded decisions from your audit journal, as they happen. Commands, file names and reasons stay in the journal."
      />
      {!localAccess ? (
        <Panel>
          <EmptyState
            title="Connect the local journal"
            description="Open the private link printed by the local server. The live view reads your own audit journal."
          />
        </Panel>
      ) : (
        <>
          <div className={`live-status ${state}`}>
            <span className="live-dot" aria-hidden="true" />
            <div className="live-status-text">
              <strong>{STATE_WORDS[state]}</strong>
              <span className="muted">
                {newest
                  ? `Last recorded action ${ago(Date.parse(newest.at), now)}`
                  : state === 'live'
                    ? 'No action recorded yet'
                    : ''}
                {polledAt && state === 'live' ? `. Checked ${ago(polledAt, now)}` : ''}
              </span>
            </div>
            <div className="live-status-actions">
              {notify === 'unsupported' ? null : notify === 'blocked' ? (
                <span className="live-notify-blocked muted">
                  <BellOff size={15} aria-hidden="true" />
                  Notifications are blocked in your browser
                </span>
              ) : (
                <button
                  className="button"
                  onClick={() => void setNotifications(notify !== 'on')}
                  aria-pressed={notify === 'on'}
                  title="Show a desktop notification when an action is denied or a result is flagged while this tab is in the background"
                >
                  <Bell size={15} aria-hidden="true" />
                  {notify === 'on' ? 'Notifications on' : 'Notify me'}
                </button>
              )}
              {state === 'error' ? (
                <button className="button" onClick={retry}>
                  <RefreshCw size={15} aria-hidden="true" />
                  Try again
                </button>
              ) : (
                <button
                  className="button"
                  onClick={togglePause}
                  aria-pressed={paused}
                  disabled={state === 'missing' || state === 'refused'}
                >
                  {paused ? (
                    <Play size={15} aria-hidden="true" />
                  ) : (
                    <Pause size={15} aria-hidden="true" />
                  )}
                  {paused ? 'Resume' : 'Pause'}
                </button>
              )}
            </div>
          </div>

          {error ? (
            <p className="control-error" role="alert">
              <CircleAlert size={18} aria-hidden="true" />
              {error}
              {state === 'error' ? ' Updates stopped.' : ' Trying again.'}
            </p>
          ) : null}

          <section aria-labelledby="live-counts-h" className="live-counts-section">
            <h2 id="live-counts-h" className="live-section-title">
              {summary && summary.window.rows > 0
                ? `The last ${summary.window.rows.toLocaleString()} recorded actions`
                : 'Recorded actions'}
              {summary?.window.first ? (
                <span className="muted">
                  {' '}
                  since {clock(summary.window.first)}
                  {summary.window.truncated ? ' (newest part of the journal)' : ''}
                </span>
              ) : null}
            </h2>
            <Counts summary={summary} />
            {summary && summary.unreadable > 0 ? (
              <p className="live-note" role="status">
                {summary.unreadable.toLocaleString()} {summary.unreadable === 1 ? 'line' : 'lines'}{' '}
                in the journal could not be read (too long, damaged or out of order), so some rows
                may be missing. Investigations checks the journal itself.
              </p>
            ) : null}
          </section>

          <Panel
            title="Feed"
            actions={
              <div className="filter-tabs" role="group" aria-label="Show">
                {(['all', 'attention'] as const).map((value) => (
                  <button
                    key={value}
                    className={filter === value ? 'is-active' : ''}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value === 'all' ? 'Everything' : 'Needs a look'}
                  </button>
                ))}
              </div>
            }
          >
            {gap ? (
              <p className="live-note" role="status">
                Some actions between your last look and now were not read. Nothing is guessed about
                them.
              </p>
            ) : null}
            {state === 'missing' ? (
              <EmptyState
                title="No journal yet"
                description="Stroq writes one the first time an agent with Stroq hooks makes a decision. Connect an agent from Protection, or see Stroq judge an action right now."
              />
            ) : state === 'refused' ? (
              <EmptyState
                title="The journal could not be read safely"
                description="It is a link, is shared with other users, is owned by someone else, or could not be read. Stroq reads only a private file in your own Stroq folder."
              />
            ) : shown.length === 0 ? (
              <EmptyState
                title={
                  state === 'connecting'
                    ? 'Reading your journal'
                    : filter === 'attention'
                      ? 'Nothing needs a look'
                      : 'Nothing recorded yet'
                }
                description={
                  filter === 'attention'
                    ? 'No denied, asked or flagged action in what is shown.'
                    : 'New actions appear here as agents make them.'
                }
              />
            ) : (
              <ul className="live-feed" aria-label="Recorded actions, newest first">
                {shown.map((entry) => (
                  <Row key={entry.row.seq} entry={entry} />
                ))}
              </ul>
            )}
            <p className="live-foot">
              <Link href="/try/" className="inline-link">
                Try an action
              </Link>{' '}
              to see what your policy would do with something you type.
            </p>
          </Panel>
          <LiveReceipt summary={summary} />
          <span className="sr-only" aria-live="polite">
            {announce}
          </span>
        </>
      )}
    </div>
  );
}
