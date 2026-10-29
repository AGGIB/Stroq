'use client';
import Link from 'next/link';
import { RefreshCw, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { AgentGlyph, Badge } from '@/components/platform-ui';
import { useProtectionVerdict, useSinceLastVisit } from './use-protection-verdict';
import { useThreatFeed } from './use-threat-feed';
import { ThreatList } from './threat-list';
import { WeekStrip } from './week-strip';
import { protectionVerdict } from '@/lib/agent-summary';
import type { JournalSummary } from '@/lib/journal-view';
import { nextSteps } from '@/lib/next-steps';
import { weekView } from '@/lib/week-view';

const ICON = { green: ShieldCheck, orange: ShieldAlert, red: ShieldOff } as const;

/** What the journal says when it cannot show the week: not read, not there yet, or not read safely. */
function JournalLine({ journal }: { journal: JournalSummary | null }) {
  if (journal === null) return <span>The journal could not be read.</span>;
  if (journal.state === 'missing' || journal.window.rows === 0)
    return <span>No decision has been recorded yet.</span>;
  if (journal.state === 'refused') return <span>The journal could not be read safely.</span>;
  return null;
}

/**
 * The first thing on the home screen: one sentence that says whether Stroq is being asked about what
 * the agents do, one row per agent, what was recorded this week and since the last visit, and what to
 * do next. It reads; it changes nothing.
 */
export function ProtectionVerdict() {
  const { localAccess, agents, journal, failed, loading, reload } = useProtectionVerdict();
  const week =
    journal !== null && journal.state === 'ready' && journal.window.rows > 0
      ? weekView(journal)
      : null;
  const since = useSinceLastVisit(agents !== null && week !== null);
  const threats = useThreatFeed();
  if (!localAccess) return null;
  if (agents === null)
    return (
      <section className="verdict verdict-pending" aria-label="Protection status">
        <p className="verdict-title">
          {loading && !failed ? 'Reading your agents…' : 'Agent status could not be read.'}
        </p>
        {failed && !loading ? (
          <button className="button" onClick={() => void reload()}>
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </button>
        ) : null}
      </section>
    );
  const verdict = protectionVerdict(agents);
  const Icon = ICON[verdict.tone];
  const steps = nextSteps(verdict, week);
  const notConnected = verdict.agents.filter((entry) => entry.state.kind === 'not-connected');
  return (
    <section className={`verdict tone-${verdict.tone}`} aria-labelledby="verdict-title">
      <div className="verdict-head">
        <Icon className="verdict-icon" size={28} aria-hidden="true" />
        <div className="verdict-text">
          <h2 id="verdict-title" className="verdict-title">
            {verdict.title}
          </h2>
          <p className="verdict-detail">{verdict.detail}</p>
        </div>
      </div>
      <ul className="verdict-agents" aria-label="Agents">
        {verdict.agents
          .filter((entry) => entry.state.kind !== 'not-connected')
          .map((entry) => (
            <li key={entry.id}>
              <AgentGlyph name={entry.name} />
              <span className="verdict-agent-name">{entry.name}</span>
              <Badge tone={entry.state.tone}>{entry.state.label}</Badge>
              <span className="verdict-agent-line">{entry.state.line}</span>
            </li>
          ))}
        {notConnected.length > 0 ? (
          <li className="verdict-agents-rest">
            <span className="verdict-agent-name">
              {notConnected.map((entry) => entry.name).join(', ')}
            </span>
            <Badge tone="muted">Not connected</Badge>
            <span className="verdict-agent-line">
              Stroq’s hooks are not in {notConnected.length === 1 ? 'its' : 'their'} settings, so
              nothing {notConnected.length === 1 ? 'it does' : 'they do'} is judged. Connect{' '}
              {notConnected.length === 1 ? 'it' : 'them'} on Agents & coverage.
            </span>
          </li>
        ) : null}
      </ul>
      <WeekStrip view={week} since={since} steps={steps} extra={<ThreatList state={threats} />} />
      <div className="verdict-foot">
        <JournalLine journal={journal} />
        <span className="verdict-links">
          <Link href="/agents/" className="inline-link">
            Open Agents & coverage
          </Link>
          <Link href="/live/" className="inline-link">
            Open Live
          </Link>
        </span>
      </div>
    </section>
  );
}
