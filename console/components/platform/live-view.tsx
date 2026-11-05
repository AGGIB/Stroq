'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Bell,
  BellOff,
  ChevronDown,
  CircleAlert,
  Pause,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Badge, EmptyState, PageHeading, Panel } from '@/components/platform-ui';
import { NotConnected } from '@/components/not-connected';
import { usePlatform } from '@/components/platform-provider';
import { useJournalLive, type LiveRow, type LiveState } from './use-journal-live';
import { EventChain } from './live-chain';
import { LiveReceipt } from './live-receipt';
import { describeRow, type JournalRow, type JournalSummary } from '@/lib/journal-view';
import { dayOptions, filterRows, findEvent, sessionOptions, showCounts } from '@/lib/live-feed';
import {
  LIVE_SHOWS,
  liveHref,
  liveSelection,
  type LiveSelection,
  type LiveShow,
} from '@/lib/live-navigation';

const STATE_WORDS: Readonly<Record<LiveState, string>> = {
  connecting: 'Connecting to your journal',
  live: 'Watching your journal',
  paused: 'Paused',
  missing: 'No journal yet',
  refused: 'Journal not readable',
  error: 'Not updating',
};

const SHOW_LABELS: Readonly<Record<LiveShow, string>> = {
  all: 'All',
  denied: 'Denied',
  asked: 'Asked',
  flagged: 'Flagged',
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

function Row({
  entry,
  rows,
  open,
  onToggle,
  onOpen,
}: {
  entry: LiveRow;
  rows: readonly JournalRow[];
  open: boolean;
  onToggle: (row: JournalRow) => void;
  onOpen: (row: JournalRow) => void;
}) {
  const { row } = entry;
  const words = describeRow(row);
  return (
    <li id={`event-${row.seq}`} className={`live-row ${entry.fresh ? 'is-fresh' : ''}`}>
      <button
        className="live-row-button"
        aria-expanded={open}
        aria-controls={`event-chain-${row.seq}`}
        onClick={() => onToggle(row)}
      >
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
        <span className="live-session mono" title={row.session}>
          {row.session.slice(-4)}
        </span>
        <ChevronDown className="live-chevron" size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div id={`event-chain-${row.seq}`}>
          <EventChain row={row} rows={rows} onOpen={onOpen} />
        </div>
      ) : null}
    </li>
  );
}

function LiveScreen() {
  const {
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
  const params = useSearchParams();
  const selection = liveSelection(params);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  function go(change: Partial<LiveSelection>) {
    window.history.replaceState(null, '', liveHref({ ...selection, ...change }));
  }

  const journalRows = useMemo(() => rows.map((entry) => entry.row), [rows]);
  const counts = showCounts(journalRows);
  const shown = useMemo(() => {
    const keep = new Set(filterRows(journalRows, selection).map((row) => row.seq));
    return rows.filter((entry) => keep.has(entry.row.seq));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, journalRows, selection.show, selection.session, selection.date, selection.text]);
  const opened = findEvent(journalRows, selection.event);
  const sessions = useMemo(() => sessionOptions(journalRows), [journalRows]);
  const days = dayOptions(summary);
  const filtered =
    selection.show !== 'all' ||
    selection.session !== null ||
    selection.date !== null ||
    selection.text !== '';
  const newest = rows[0]?.row;
  const announce =
    newest && (newest.decision === 'deny' || newest.decision === 'ask' || newest.scan === 'suspect')
      ? `${describeRow(newest).verdict}: ${describeRow(newest).title}`
      : '';
  const toggle = (row: JournalRow) =>
    go({ event: opened?.seq === row.seq ? null : row.evidenceSha });
  const open = (row: JournalRow) => {
    go({ event: row.evidenceSha });
    requestAnimationFrame(() =>
      document.getElementById(`event-${row.seq}`)?.scrollIntoView({ block: 'nearest' }),
    );
  };

  return (
    <div className="page-stack" role="region" aria-label="Live">
      <PageHeading
        title="Live"
        description="What your agents are doing: recorded decisions from your audit journal, as they happen. Commands, file names and reasons stay in the journal."
      />
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
            {summary.unreadable.toLocaleString()} {summary.unreadable === 1 ? 'line' : 'lines'} in
            the journal could not be read (too long, damaged or out of order), so some rows may be
            missing.
          </p>
        ) : null}
      </section>

      <Panel
        title="Feed"
        actions={
          <div className="filter-tabs" role="group" aria-label="Show">
            {LIVE_SHOWS.map((value) => (
              <button
                key={value}
                className={selection.show === value ? 'is-active' : ''}
                aria-pressed={selection.show === value}
                onClick={() => go({ show: value, event: null })}
              >
                {SHOW_LABELS[value]}
                <span>{counts[value]}</span>
              </button>
            ))}
          </div>
        }
      >
        <div className="toolbar live-toolbar">
          <label className="search-field">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label="Search the rows on screen"
              name="live-search"
              placeholder="Search rows, tools, rules…"
              autoComplete="off"
              spellCheck={false}
              value={selection.text}
              onChange={(event) => go({ text: event.target.value, event: null })}
            />
          </label>
          <select
            aria-label="Filter by session"
            className="select-field"
            value={selection.session ?? ''}
            onChange={(event) => go({ session: event.target.value || null, event: null })}
          >
            <option value="">All sessions</option>
            {sessions.map((item) => (
              <option key={item.id} value={item.id}>
                Session …{item.short} · {item.rows} {item.rows === 1 ? 'row' : 'rows'}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by day"
            className="select-field"
            value={selection.date ?? ''}
            onChange={(event) => go({ date: event.target.value || null, event: null })}
          >
            <option value="">Any day</option>
            {days.map((item) => (
              <option key={item.date} value={item.date}>
                {item.date}
                {item.read === 'part' ? ' (part of the day)' : ''}
              </option>
            ))}
          </select>
          {filtered ? (
            <button
              className="button subtle small"
              onClick={() => window.history.replaceState(null, '', '/live/')}
            >
              Reset filters
            </button>
          ) : null}
        </div>
        {gap ? (
          <p className="live-note" role="status">
            Some actions between your last look and now were not read. Nothing is guessed about
            them.
          </p>
        ) : null}
        {selection.event !== null && opened === null && rows.length > 0 ? (
          <p className="live-note" role="status">
            That event is not in the newest rows on screen. Run <code>stroq why</code> in a terminal
            to read any entry of the journal.
          </p>
        ) : null}
        {state === 'missing' ? (
          <EmptyState
            title="No journal yet"
            description="Stroq writes one the first time an agent with Stroq hooks makes a decision. Connect an agent on Agents, or see what Stroq would decide on Rules."
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
                : filtered
                  ? 'No row matches'
                  : 'Nothing recorded yet'
            }
            description={
              filtered
                ? 'No row on screen matches these filters. Reset them to see every row.'
                : 'New actions appear here as agents make them.'
            }
          />
        ) : (
          <ul className="live-feed" aria-label="Recorded actions, newest first">
            {shown.map((entry) => (
              <Row
                key={entry.row.seq}
                entry={entry}
                rows={journalRows}
                open={opened?.seq === entry.row.seq}
                onToggle={toggle}
                onOpen={open}
              />
            ))}
          </ul>
        )}
        <p className="live-foot">
          <Link href="/policies/#try" className="inline-link">
            Try an action
          </Link>{' '}
          on Rules to see what your policy would do with something you type.
        </p>
      </Panel>
      <LiveReceipt summary={summary} />
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}

export function LivePage() {
  const { localAccess } = usePlatform();
  if (!localAccess) return <NotConnected title="Live" />;
  return (
    <Suspense fallback={<p className="control-meta">Reading your journal…</p>}>
      <LiveScreen />
    </Suspense>
  );
}
