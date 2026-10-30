'use client';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Badge } from '@/components/platform-ui';
import { THREAT_SOURCE_HOME, threatUrl, type Severity, type ThreatMatch } from '@/lib/threat-feed';
import {
  SEVERITY_LABELS,
  comparedSentence,
  patchLabel,
  unavailableSentence,
  whySentence,
} from '@/lib/threat-words';
import type { ThreatFeedState } from './use-threat-feed';

/** How many matches the home screen lists; the rest are counted. */
const SHOWN = 3;

const TONE: Readonly<Record<Severity, 'red' | 'orange' | 'muted'>> = {
  critical: 'red',
  high: 'orange',
  medium: 'muted',
  low: 'muted',
  unknown: 'muted',
};

const day = (date: string): string =>
  new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

function Row({ match }: { match: ThreatMatch }) {
  const url = threatUrl(match.slug);
  const patch = patchLabel(match);
  return (
    <li className="threat">
      <div className="threat-head">
        <Badge tone={TONE[match.severity]}>{SEVERITY_LABELS[match.severity]}</Badge>
        {patch !== null ? <span className="threat-patch">{patch}</span> : null}
        {url === null ? (
          <span className="threat-title">{match.title}</span>
        ) : (
          <a className="threat-title" href={url} target="_blank" rel="noopener noreferrer">
            {match.title}
            <span className="sr-only"> (opens pwn.watch in a new tab)</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      <p className="threat-why">
        {match.live ? 'Live since ' : 'Began '}
        {day(match.startedAt)}. {whySentence(match)}
      </p>
    </li>
  );
}

/**
 * pwn.watch's incidents that match this project, on the home screen, or one line on how to turn the
 * feed on. Each match links to its page on pwn.watch, which says what to do.
 */
export function ThreatList({ state }: { state: ThreatFeedState }) {
  const { on, feed, loading, failed } = state;
  if (on === null) return null;
  if (!on)
    return (
      <p className="threats-off">
        Incidents from pwn.watch that name what this project uses are off.{' '}
        <Link href="/settings/#threat-feed" className="inline-link">
          Turn them on in Settings
        </Link>
      </p>
    );
  const body =
    feed === null ? (
      <p className="threats-note" role="status">
        {loading && !failed ? 'Reading pwn.watch’s list…' : 'The threat feed could not be read.'}
      </p>
    ) : feed.state === 'unavailable' ? (
      <p className="threats-note">{unavailableSentence(feed.problem)}</p>
    ) : (
      <>
        {feed.matches.length === 0 ? (
          <p className="threats-note">
            No incident on the list names a package this project lists, an agent set up here, or an
            ecosystem it uses. Only the packages its own files list are compared, not what they pull
            in.
          </p>
        ) : (
          <ol className="threat-list" role="list">
            {feed.matches.slice(0, SHOWN).map((match) => (
              <Row key={match.slug} match={match} />
            ))}
          </ol>
        )}
        {feed.matches.length > SHOWN || feed.more > 0 ? (
          <p className="threats-note">
            {(feed.matches.length - SHOWN + feed.more).toLocaleString('en-US')} more{' '}
            {feed.matches.length - SHOWN + feed.more === 1 ? 'matches' : 'match'} this project.
          </p>
        ) : null}
        <p className="threats-compared">{comparedSentence(feed)}</p>
      </>
    );
  return (
    <section className="threats" aria-labelledby="threats-title">
      <div className="threats-head">
        <h3 id="threats-title" className="threats-title">
          Incidents that name what this project uses
        </h3>
        <a
          className="inline-link threats-source"
          href={THREAT_SOURCE_HOME}
          target="_blank"
          rel="noopener noreferrer"
        >
          from pwn.watch<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
      {body}
    </section>
  );
}
