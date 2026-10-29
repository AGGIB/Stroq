'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import type { JournalSince } from '@/lib/journal-view';
import type { NextStep } from '@/lib/next-steps';
import { dayWords, sinceSentence, weekSentence, type WeekView } from '@/lib/week-view';

/** The share of the tallest bar a count takes, as a CSS length. */
const share = (count: number, peak: number): string =>
  peak === 0 ? '0%' : `${Math.round((count / peak) * 1000) / 10}%`;

function Bars({ view }: { view: WeekView }) {
  return (
    // `role="list"`: Safari drops the list from a list styled without markers.
    <ol className="week-bars" role="list" aria-label="Denied, asked and flagged, by day">
      {view.bars.map((bar) => (
        <li key={bar.date} className={`week-day${bar.read === 'none' ? ' is-unread' : ''}`}>
          <span className="week-column" aria-hidden="true">
            {bar.read === 'none' ? (
              <span className="week-unread" />
            ) : bar.attention === 0 ? (
              <span className="week-none" />
            ) : (
              <span className="week-stack" style={{ height: share(bar.attention, view.peak) }}>
                {bar.deny > 0 ? (
                  <span className="week-deny" style={{ flexGrow: bar.deny }} />
                ) : null}
                {bar.ask > 0 ? <span className="week-ask" style={{ flexGrow: bar.ask }} /> : null}
                {bar.suspect > 0 ? (
                  <span className="week-suspect" style={{ flexGrow: bar.suspect }} />
                ) : null}
              </span>
            )}
          </span>
          <span className="week-label" aria-hidden="true">
            {bar.label}
          </span>
          <span className="sr-only">{dayWords(bar)}</span>
        </li>
      ))}
    </ol>
  );
}

function Steps({ steps }: { steps: readonly NextStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="next-steps">
      <h3 id="next-steps-title" className="next-steps-title">
        Next
      </h3>
      <ol className="next-steps-list" role="list">
        {steps.map((step) => (
          <li key={step.key} className="next-step">
            <div className="next-step-text">
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </div>
            {step.command !== undefined ? (
              <CopyCommand command={step.command} className="next-step-command" />
            ) : step.href !== undefined ? (
              <Link href={step.href} className="inline-link next-step-link">
                Open<span className="sr-only">: {step.title}</span>
                <ArrowRight size={14} aria-hidden="true" />
              </Link>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * What changed this week, on the home screen: what needed a look each day, what was recorded since the
 * last visit, and what to do next. It reads the journal's newest part; it changes nothing.
 */
export function WeekStrip({
  view,
  since,
  steps,
  extra = null,
}: {
  view: WeekView | null;
  since: JournalSince | null;
  steps: readonly NextStep[];
  /** What goes between the week and the steps (the threat feed). */
  extra?: ReactNode;
}) {
  if (view === null && steps.length === 0 && extra === null) return null;
  return (
    <section
      className="verdict-week"
      aria-labelledby={
        view !== null ? 'week-title' : steps.length > 0 ? 'next-steps-title' : undefined
      }
    >
      {view !== null ? (
        <div className="week-summary">
          <div className="week-text">
            <h3 id="week-title" className="week-title">
              This week
            </h3>
            <p className="week-sentence">{weekSentence(view)}</p>
            {since !== null && since.state === 'ready' ? (
              <p className="week-since">{sinceSentence(since, new Date())}</p>
            ) : null}
            <p className="week-key" aria-hidden="true">
              <span className="week-key-item">
                <span className="week-swatch week-deny" /> denied
              </span>
              <span className="week-key-item">
                <span className="week-swatch week-ask" /> asked you
              </span>
              <span className="week-key-item">
                <span className="week-swatch week-suspect" /> flagged
              </span>
            </p>
          </div>
          <Bars view={view} />
        </div>
      ) : null}
      {extra}
      <Steps steps={steps} />
    </section>
  );
}
