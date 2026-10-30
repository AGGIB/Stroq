import { describe, expect, it } from 'vitest';
import { JOURNAL_LIMITATIONS, type JournalSince, type JournalSummary } from './journal-view';
import { LAST_VISIT_KEY, PIN_MS, PREVIOUS_VISIT_KEY, openVisit } from './last-visit';
import { MAX_NEXT_STEPS, nextSteps } from './next-steps';
import { dayWords, sinceSentence, visitTime, weekSentence, weekView } from './week-view';
import type { ProtectionVerdict } from './agent-summary';

const DATES = [
  '2026-10-22',
  '2026-10-23',
  '2026-10-24',
  '2026-10-25',
  '2026-10-26',
  '2026-10-27',
  '2026-10-28',
];
const summary = (over: Partial<JournalSummary> = {}): JournalSummary => ({
  schema: 'stroq-journal-summary/1',
  source: 'local',
  generatedAt: '2026-10-28T10:00:00.000Z',
  state: 'ready',
  window: { rows: 100, first: null, last: null, truncated: false },
  counts: { allow: 90, ask: 3, deny: 2, suspect: 1 },
  tools: {},
  classes: [],
  notable: [],
  days: DATES.map((date, i) => ({
    date,
    read: 'all' as const,
    allow: 10,
    ask: i === 2 ? 2 : 0,
    deny: i === 6 ? 1 : 0,
    suspect: i === 2 ? 1 : 0,
  })),
  daysComplete: true,
  unreadable: 0,
  limitations: [...JOURNAL_LIMITATIONS],
  ...over,
});
const quietDays = DATES.map((date) => ({
  date,
  read: 'all' as const,
  allow: 1,
  ask: 0,
  deny: 0,
  suspect: 0,
}));

describe('the week on the home screen', () => {
  it('is one bar a day of what needs a look, today last', () => {
    const view = weekView(summary());
    expect(view.bars.map((bar) => bar.label)).toEqual([
      'Thu',
      'Fri',
      'Sat',
      'Sun',
      'Mon',
      'Tue',
      'Today',
    ]);
    expect(view.bars.map((bar) => bar.attention)).toEqual([0, 0, 3, 0, 0, 0, 1]);
    expect(view.peak).toBe(3);
    expect(view.totals).toEqual({ allow: 70, ask: 2, deny: 1, suspect: 1 });
  });

  it('says what was recorded, never that something was stopped', () => {
    expect(weekSentence(weekView(summary()))).toBe(
      'Recorded in the last 7 days: 1 denied, 2 asked you, 1 flagged and 70 allowed.',
    );
    expect(weekSentence(weekView(summary({ days: quietDays })))).toBe(
      'Recorded in the last 7 days: 7 allowed.',
    );
    const empty = quietDays.map((day) => ({ ...day, allow: 0 }));
    expect(weekSentence(weekView(summary({ days: empty })))).toBe(
      'Nothing was recorded in the last 7 days.',
    );
    for (const text of [weekSentence(weekView(summary())), dayWords(weekView(summary()).bars[0]!)])
      expect(text).not.toMatch(/stop|protect|safe|secure/i);
  });

  it('says that lines could not be read, where some could not', () => {
    const sentence = weekSentence(weekView(summary({ unreadable: 3, daysComplete: false })));
    expect(sentence).toContain('3 lines of the journal could not be read');
    expect(sentence).toContain('some actions may be missing');
  });

  it('says which days were not read, and draws them as not read', () => {
    const days = summary().days.map((day, i) =>
      i < 2 ? { ...day, read: 'none' as const, allow: 0, ask: 0, deny: 0, suspect: 0 } : day,
    );
    const partly = days.map((day, i) => (i === 2 ? { ...day, read: 'part' as const } : day));
    const view = weekView(summary({ days: partly, daysComplete: false }));
    expect(weekSentence(view)).toContain(
      'Sat is counted only in part, and the days before it not at all.',
    );
    expect(dayWords(view.bars[0]!)).toBe('Thu: not read');
    expect(dayWords(view.bars[2]!)).toBe(
      'Sat: 2 asked you, 1 flagged and 10 allowed, only part of the day read',
    );
    expect(weekSentence(weekView(summary({ days, daysComplete: false })))).toContain(
      'Fri and the days before it are not counted.',
    );
  });

  it('puts a day in words for a screen reader', () => {
    const view = weekView(summary());
    expect(dayWords(view.bars[6]!)).toBe('Today: 1 denied and 10 allowed');
    expect(dayWords({ ...view.bars[0]!, allow: 0 })).toBe('Thu: nothing recorded');
  });
});

describe('since the last visit', () => {
  const since = (over: Partial<JournalSince> = {}): JournalSince => ({
    schema: 'stroq-journal-since/1',
    source: 'local',
    generatedAt: '2026-10-28T10:00:00.000Z',
    state: 'ready',
    since: new Date(2026, 9, 27, 14, 5).toISOString(),
    counts: { allow: 4, ask: 1, deny: 0, suspect: 0 },
    complete: true,
    unreadable: 0,
    limitations: [...JOURNAL_LIMITATIONS],
    ...over,
  });
  const now = new Date(2026, 9, 28, 9, 30);

  it('names the visit by day and time, or by time today', () => {
    expect(visitTime(new Date(2026, 9, 27, 14, 5).toISOString(), now)).toBe('Tue 14:05');
    expect(visitTime(new Date(2026, 9, 28, 8, 1).toISOString(), now)).toBe('08:01');
    expect(visitTime(new Date(2026, 8, 1, 8, 1).toISOString(), now)).toBe('2026-09-01');
  });

  it('says what was recorded since, or that nothing was', () => {
    expect(sinceSentence(since(), now)).toBe(
      'Since your last visit (Tue 14:05): 1 asked you and 4 allowed.',
    );
    expect(sinceSentence(since({ counts: { allow: 0, ask: 0, deny: 0, suspect: 0 } }), now)).toBe(
      'Nothing was recorded since your last visit (Tue 14:05).',
    );
  });

  it('says why it may be missing some', () => {
    expect(sinceSentence(since({ complete: false }), now)).toContain(
      'older than the part of the journal read',
    );
    expect(sinceSentence(since({ complete: false, unreadable: 1 }), now)).toContain(
      '1 line of the journal could not be read',
    );
  });
});

describe('the last visit, kept in this browser', () => {
  const WORKSPACE = 'workspace-0123456789abcdef01234567';
  const store = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
  };
  const lastKey = `${LAST_VISIT_KEY}:${WORKSPACE}`;
  const pinKey = `${PREVIOUS_VISIT_KEY}:${WORKSPACE}`;

  it('is none on a first visit, and is recorded only when asked to', () => {
    const local = store();
    const now = new Date('2026-10-28T09:00:00.000Z');
    const visit = openVisit(now, { local, session: store() }, WORKSPACE);
    expect(visit.previous).toBeNull();
    expect(local.values.has(lastKey)).toBe(false);
    visit.record();
    expect(local.values.get(lastKey)).toBe(now.toISOString());
  });

  it('stays the same in a tab however often the page is opened, for a while', () => {
    const local = store();
    local.setItem(lastKey, '2026-10-27T09:00:00.000Z');
    const session = store();
    const first = openVisit(new Date('2026-10-28T09:00:00.000Z'), { local, session }, WORKSPACE);
    first.record();
    const again = openVisit(new Date('2026-10-28T09:05:00.000Z'), { local, session }, WORKSPACE);
    expect(first.previous).toBe('2026-10-27T09:00:00.000Z');
    expect(again.previous).toBe('2026-10-27T09:00:00.000Z');
    // Past the pin, a tab left open reads the newest visit again.
    const later = new Date(Date.parse('2026-10-28T09:00:00.000Z') + PIN_MS + 1);
    expect(openVisit(later, { local, session }, WORKSPACE).previous).toBe(
      '2026-10-28T09:00:00.000Z',
    );
  });

  it('is kept apart for each workspace', () => {
    const local = store();
    local.setItem(lastKey, '2026-10-27T09:00:00.000Z');
    const session = store();
    const other = openVisit(
      new Date('2026-10-28T09:00:00.000Z'),
      { local, session },
      'workspace-ffffffffffffffffffffffff',
    );
    expect(other.previous).toBeNull();
    expect(session.values.has(pinKey)).toBe(false);
    other.record();
    expect(local.values.get(lastKey)).toBe('2026-10-27T09:00:00.000Z');
  });

  it('ignores what is not a time, or one still to come, pinned or not', () => {
    const now = new Date('2026-10-28T09:00:00.000Z');
    const local = store();
    local.setItem(lastKey, 'yesterday');
    expect(openVisit(now, { local, session: store() }, WORKSPACE).previous).toBeNull();
    const future = store();
    future.setItem(lastKey, '2099-01-01T00:00:00.000Z');
    expect(openVisit(now, { local: future, session: store() }, WORKSPACE).previous).toBeNull();
    const pinned = store();
    pinned.setItem(
      pinKey,
      JSON.stringify({ previous: '2099-01-01T00:00:00.000Z', at: now.toISOString() }),
    );
    expect(openVisit(now, { local: store(), session: pinned }, WORKSPACE).previous).toBeNull();
  });

  it('keeps what it can when a storage fails, and works with none at all', () => {
    const now = new Date('2026-10-28T09:00:00.000Z');
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    const local = store();
    local.setItem(lastKey, '2026-10-27T09:00:00.000Z');
    // A tab that cannot pin still knows the last visit.
    expect(openVisit(now, { local, session: broken }, WORKSPACE).previous).toBe(
      '2026-10-27T09:00:00.000Z',
    );
    expect(openVisit(now, { local: broken, session: broken }, WORKSPACE).previous).toBeNull();
    const nowhere = openVisit(now, { local: null, session: null }, WORKSPACE);
    expect(nowhere.previous).toBeNull();
    expect(() => nowhere.record()).not.toThrow();
  });
});

describe('what to do next', () => {
  const agent = (id: 'claude-code' | 'cursor' | 'codex', name: string, kind: string) => ({
    id,
    name,
    state: { kind, label: kind, tone: 'muted', line: '' },
  });
  const verdict = (agents: ReturnType<typeof agent>[]): ProtectionVerdict =>
    ({ tone: 'green', title: 't', detail: 'd', agents }) as unknown as ProtectionVerdict;

  it('puts hooks that will not work first, then an agent to connect, then one to check', () => {
    const steps = nextSteps(
      verdict([
        agent('claude-code', 'Claude Code', 'connected-unseen'),
        agent('cursor', 'Cursor', 'not-connected'),
        agent('codex', 'Codex CLI', 'attention'),
      ]),
      weekView(summary()),
    );
    expect(steps.map((s) => s.key)).toEqual(['fix', 'connect', 'prove']);
    expect(steps[1]?.command).toBe('npx @stroq/cli init --agent cursor');
    expect(steps[2]?.command).toBe('npx @stroq/cli prove');
  });

  it('sends what prove cannot check to the page that tests it', () => {
    const steps = nextSteps(verdict([agent('cursor', 'Cursor', 'connected-unseen')]), null);
    expect(steps[0]).toMatchObject({ key: 'test', href: '/agents/' });
  });

  it('points at what needs a look on Live, and with nothing to fix offers two checks', () => {
    const seen = verdict([agent('claude-code', 'Claude Code', 'connected-seen')]);
    const steps = nextSteps(seen, weekView(summary()));
    expect(steps.map((s) => s.key)).toEqual(['review', 'sent', 'attack']);
    expect(steps[0]).toMatchObject({ title: 'See the 4 that need a look', href: '/live/' });
    const quiet = weekView(summary({ days: quietDays }));
    expect(nextSteps(seen, quiet).map((s) => s.key)).toEqual(['sent', 'attack']);
  });

  it('offers a look back at past sessions when nothing has been recorded yet', () => {
    const seen = verdict([agent('claude-code', 'Claude Code', 'connected-seen')]);
    const steps = nextSteps(seen, null);
    expect(steps.map((s) => s.key)).toEqual(['look-back', 'sent', 'attack']);
    expect(steps[0]?.command).toBe('npx @stroq/cli replay --all');
  });

  it('never offers more than three', () => {
    const steps = nextSteps(
      verdict([
        agent('claude-code', 'Claude Code', 'connected-unseen'),
        agent('cursor', 'Cursor', 'not-connected'),
        agent('codex', 'Codex CLI', 'attention'),
      ]),
      weekView(summary()),
    );
    expect(steps.length).toBe(MAX_NEXT_STEPS);
  });
});
