import { NumberTicker } from '@/components/magicui/number-ticker';
import { WEEK, WEEK_TOTALS } from '@/lib/data';
import { StatusSquare } from './status-square';

const STATS = [
  { kind: 'block', value: WEEK_TOTALS.blocked, words: 'blocked' },
  { kind: 'ask', value: WEEK_TOTALS.askedOrFlagged, words: 'asked or flagged' },
  { kind: 'allow', value: WEEK_TOTALS.allowed, words: 'allowed' },
] as const;

/** This week in three numbers. The one place that moves on load, once. */
export function WeekStats() {
  return (
    <ul
      aria-label="This week"
      className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-ink-2"
    >
      {STATS.map((stat, i) => (
        <li key={stat.kind} className="inline-flex items-center gap-2 whitespace-nowrap">
          <StatusSquare kind={stat.kind} size="sm" decorative />
          <span>
            <NumberTicker
              value={stat.value}
              delay={0.05 * i}
              playOnceKey={`stroq-week-${stat.kind}`}
              className="font-semibold text-foreground"
            />{' '}
            {stat.words}
          </span>
        </li>
      ))}
      <li className="text-ink-3">this week</li>
    </ul>
  );
}

const PX_PER_CALL = 7;

/** Seven small bars: stops and questions per day. */
export function WeekSpark() {
  const label = WEEK.map((d) => `${d.day} ${d.blocked + d.asked}`).join(', ');
  return (
    <figure className="flex flex-col items-start gap-1.5 md:items-end">
      <figcaption className="text-xs text-ink-3">Stops and questions, 7 days</figcaption>
      <div
        role="img"
        aria-label={`Stops and questions per day: ${label}.`}
        className="flex items-end gap-1.5"
      >
        {WEEK.map((d, i) => (
          <span key={d.day} className="flex flex-col items-center gap-1">
            <span className="flex h-9 w-3.5 flex-col-reverse gap-px border-b border-hairline-strong">
              {d.blocked > 0 ? (
                <i
                  className="block rounded-[2px] bg-st-red"
                  style={{ height: d.blocked * PX_PER_CALL }}
                />
              ) : null}
              {d.asked > 0 ? (
                <i
                  className="block rounded-[2px] bg-st-amber"
                  style={{ height: d.asked * PX_PER_CALL }}
                />
              ) : null}
            </span>
            <b
              className={
                i === WEEK.length - 1
                  ? 'text-[11px] font-semibold leading-3'
                  : 'text-[11px] font-medium leading-3 text-ink-3'
              }
            >
              {d.day[0]}
            </b>
          </span>
        ))}
      </div>
    </figure>
  );
}
