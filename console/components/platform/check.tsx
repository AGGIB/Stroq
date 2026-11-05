'use client';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react';
import { Hoo } from '@/components/hoo';
import { useScrollToHash } from '@/hooks/use-scroll-to-hash';
import { CopyCommand } from '@/components/copy-command';
import { NotConnected } from '@/components/not-connected';
import { usePlatform } from '@/components/platform-provider';
import { AgentGlyph, Badge, PageHeading } from '@/components/platform-ui';
import { protectionVerdict } from '@/lib/agent-summary';
import {
  CARD_ERROR_MESSAGES,
  checkedAgo,
  type CardMoment,
  type CardPresentation,
  type CardState,
} from '@/lib/card';
import { PostureStrip } from './posture-strip';
import { SetupChecks } from './setup-checks';
import { useCard } from './use-card';
import { useProtectionVerdict } from './use-protection-verdict';

const INIT_COMMAND = 'npx @stroq/cli init';
const num = (value: number): string => value.toLocaleString('en-US');

/** What a count row says under it, when it has something to point at. */
const ROW_HINT: Readonly<Record<string, (count: number) => string | null>> = {
  autorun: (count) =>
    count > 0
      ? 'The folders are listed below. To look inside one, run stroq inspect <folder>.'
      : null,
};

function Evidence({ moment }: { moment: CardMoment }) {
  return (
    <div className="check-evidence">
      {moment.groups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h4>{group.title}</h4>
          <dl>
            {group.rows.map(([label, value], index) => (
              <div key={`${label}-${index}`} className={label === '' ? 'is-plain' : undefined}>
                {label === '' ? null : <dt>{label}</dt>}
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section aria-label="Dig deeper">
        <h4>In a terminal</h4>
        <CopyCommand command={`stroq show ${moment.n}`} />
        {moment.next.map((command) => (
          <CopyCommand key={command} command={command} />
        ))}
      </section>
    </div>
  );
}

function MomentList({ moments, start }: { moments: readonly CardMoment[]; start: number }) {
  return (
    <ol className="check-moments" start={start}>
      {moments.map((moment) => (
        <li key={moment.n} id={`moment-${moment.n}`}>
          <details>
            <summary>
              <span className="check-moment-n" aria-hidden="true">
                {moment.n}
              </span>
              <span className="check-moment-line">{moment.line}</span>
              <span className="check-moment-open">Show the evidence</span>
            </summary>
            <Evidence moment={moment} />
          </details>
        </li>
      ))}
    </ol>
  );
}

function Moments({ card }: { card: CardPresentation }) {
  if (card.moments.length === 0) return null;
  const first = card.moments.slice(0, card.shown);
  const rest = card.moments.slice(card.shown);
  return (
    <section className="check-found" aria-labelledby="check-found-title">
      <h2 id="check-found-title">Worth a look</h2>
      <MomentList moments={first} start={1} />
      {rest.length > 0 ? (
        <details className="check-more">
          <summary>
            {rest.length} more {rest.length === 1 ? 'moment' : 'moments'}
          </summary>
          <MomentList moments={rest} start={card.shown + 1} />
        </details>
      ) : null}
    </section>
  );
}

function CardBody({ card }: { card: CardPresentation }) {
  const { view } = card;
  if (view.kind === 'nothing-to-read')
    return (
      <div className="check-text">
        <h2 id="check-card-title" className="check-title">
          {view.title}
        </h2>
        <p className="check-lead">{view.looked}</p>
      </div>
    );
  return (
    <div className="check-text">
      <h2 id="check-card-title" className="check-title">
        {view.title}
      </h2>
      <p className="check-lead">{view.subtitle}</p>
      <ul className="check-counts" aria-label="What the check counted">
        {view.rows.map((row) => {
          const hint = ROW_HINT[row.id]?.(row.count) ?? null;
          return (
            <li key={row.id} id={row.id}>
              <strong className="check-count">{num(row.count)}</strong>
              <span>
                {row.text}
                {hint ? <small>{hint}</small> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {view.notes.length > 0 ? (
        <ul className="check-notes" aria-label="What the check could not look at">
          {view.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {view.nothing !== null ? <p className="check-nothing">{view.nothing}</p> : null}
    </div>
  );
}

function Status({ state, now }: { state: CardState; now: number }) {
  if (state.status === 'running')
    return (
      <p className="check-status" role="status">
        <LoaderCircle size={15} className="spin" aria-hidden="true" />
        {state.result === null
          ? 'Hoo is reading your agent sessions on this machine. A first check can take half a minute.'
          : 'Checking again. The card below is the last one.'}
      </p>
    );
  if (state.status === 'failed' && state.error !== null)
    return (
      <p className="control-error" role="alert">
        <CircleAlert size={18} aria-hidden="true" />
        {CARD_ERROR_MESSAGES[state.error]}
        {state.result === null ? '' : ' The card below is the last one that was made.'}
      </p>
    );
  if (state.finishedAt !== null && state.result !== null)
    return (
      <p className="check-status">
        Checked {checkedAgo(state.finishedAt, now)} · version {state.result.version}
      </p>
    );
  return null;
}

/** One line for each agent: whether Stroq's hooks are in its settings, in the words of Agents. */
function AgentLines() {
  const { agents, failed, loading, reload } = useProtectionVerdict();
  const [now] = useState(() => Date.now());
  return (
    <section className="check-agents" aria-labelledby="check-agents-title">
      <h2 id="check-agents-title">Your agents</h2>
      {agents === null ? (
        <p className="control-meta" role="status">
          {loading && !failed ? 'Reading your agents…' : 'Agent status could not be read.'}{' '}
          {failed && !loading ? (
            <button className="button small" onClick={() => void reload()}>
              <RefreshCw size={14} aria-hidden="true" />
              Try again
            </button>
          ) : null}
        </p>
      ) : (
        <ul>
          {protectionVerdict(agents, now).agents.map((entry) => (
            <li key={entry.id}>
              <AgentGlyph name={entry.name} />
              <span className="check-agent-name">{entry.name}</span>
              <Badge tone={entry.state.tone}>{entry.state.label}</Badge>
              <span className="check-agent-line">{entry.state.line}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="check-fix">
        <span>Connect an agent, or fix one that needs it:</span>
        <CopyCommand command={INIT_COMMAND} />
        <Link href="/agents/" className="inline-link">
          Open Agents
        </Link>
      </p>
    </section>
  );
}

function CheckScreen() {
  const { state, problem, check } = useCard();
  useScrollToHash(state?.result != null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const running = state?.status === 'running';
  const card = state?.result ?? null;
  const next = card?.view.next;
  return (
    <div className="page-stack check-page">
      <PageHeading
        title="Check"
        description="What your agents did in the last days, read from the sessions they keep on this machine."
        actions={
          <button
            className="button primary"
            disabled={state === null || running || !state.engine.available}
            onClick={() => void check()}
          >
            <RefreshCw size={16} className={running ? 'spin' : undefined} aria-hidden="true" />
            Check again
          </button>
        }
      />
      {problem ? (
        <p className="control-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          {problem}
        </p>
      ) : null}
      {state !== null ? <Status state={state} now={now} /> : null}
      {state === null && problem === null ? (
        <p className="check-status" role="status">
          <LoaderCircle size={15} className="spin" aria-hidden="true" />
          Connecting to the local engine…
        </p>
      ) : null}
      {card !== null ? (
        <section
          className={`check-card ${running ? 'is-stale' : ''}`}
          aria-labelledby="check-card-title"
          aria-busy={running}
        >
          <Hoo frame={card.owl} />
          <CardBody card={card} />
        </section>
      ) : state?.status === 'running' ? (
        <section className="check-card is-waiting" aria-label="Checking">
          <Hoo frame="idle" />
        </section>
      ) : null}
      {card !== null ? <Moments card={card} /> : null}
      {next !== undefined && next.command !== INIT_COMMAND ? (
        <p className="check-next">
          <span>{next.label}</span>
          <CopyCommand command={next.command} />
        </p>
      ) : null}
      <AgentLines />
      <PostureStrip />
      <p className="check-reads">
        The check reads the session files Claude Code and Codex keep on this machine, and the key
        files those sessions could have seen, here. Nothing is sent anywhere.
      </p>
      <SetupChecks />
    </div>
  );
}

export function CheckPage() {
  const { localAccess } = usePlatform();
  if (!localAccess) return <NotConnected title="Check" />;
  return (
    <Suspense
      fallback={
        <div className="control-empty" role="status">
          Reading the card…
        </div>
      }
    >
      <CheckScreen />
    </Suspense>
  );
}
