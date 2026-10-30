import { describe, expect, it } from 'vitest';
import {
  JOURNAL_LIMITATIONS,
  MAX_TAIL_ROWS,
  applyTail,
  cursorToken,
  parseCursorToken,
  describeRow,
  validateJournalRow,
  validateJournalSummary,
  validateJournalTail,
  validateTailRequest,
  type JournalRow,
  type JournalSummary,
  type JournalTail,
  validateJournalSince,
  validateSinceRequest,
  localDate,
  type JournalSince,
} from './journal-view';

const sha = (c: string) => c.repeat(64);
const row = (over: Partial<JournalRow> = {}): JournalRow => ({
  seq: 7,
  at: '2026-10-27T10:00:00.000Z',
  phase: 'pre',
  decision: 'deny',
  scan: null,
  tool: 'shell',
  classes: ['shell.network', 'secret.egress'],
  ruleId: 'deny-secret-egress',
  session: 'session-0123456789abcdef',
  evidenceSha: sha('a'),
  ...over,
});
const tail = (over: Partial<JournalTail> = {}): JournalTail => ({
  schema: 'stroq-journal-tail/1',
  source: 'local',
  generatedAt: '2026-10-27T10:00:01.000Z',
  state: 'ready',
  cursor: 'ok',
  rows: [row()],
  head: { seq: 7, lineSha: sha('b') },
  windowTruncated: false,
  unreadable: 0,
  limitations: [...JOURNAL_LIMITATIONS],
  ...over,
});
const summary = (over: Partial<JournalSummary> = {}): JournalSummary => ({
  schema: 'stroq-journal-summary/1',
  source: 'local',
  generatedAt: '2026-10-27T10:00:01.000Z',
  state: 'ready',
  window: {
    rows: 12,
    first: '2026-10-27T09:00:00.000Z',
    last: '2026-10-27T10:00:00.000Z',
    truncated: false,
  },
  counts: { allow: 9, ask: 1, deny: 1, suspect: 1 },
  tools: { shell: 6, 'file-read': 4, 'file-write': 2 },
  classes: [{ class: 'shell.network', count: 3 }],
  notable: [row()],
  days: [
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
  ].map((date) => ({ date, read: 'all' as const, allow: 0, ask: 0, deny: 0, suspect: 0 })),
  daysComplete: true,
  unreadable: 0,
  limitations: [...JOURNAL_LIMITATIONS],
  ...over,
});

describe('journal row', () => {
  it('accepts a pre decision and a flagged read result', () => {
    expect(validateJournalRow(row())).toBe(true);
    expect(
      validateJournalRow(
        row({ phase: 'post', decision: null, scan: 'suspect', ruleId: null, classes: [] }),
      ),
    ).toBe(true);
  });

  it('refuses every field the console deliberately withholds', () => {
    for (const extra of [
      { summary: 'curl https://x.invalid' },
      { command: 'ls' },
      { reason: 'because' },
      { sessionId: 'private-session' },
      { secrets: [{ name: 'KEY' }] },
      { provenance: [] },
      { hostBlocked: true },
    ])
      expect(validateJournalRow({ ...row(), ...extra }), JSON.stringify(extra)).toBe(false);
  });

  it('refuses a raw session id, an unknown class and an unknown tool', () => {
    expect(validateJournalRow(row({ session: 'private-session' }))).toBe(false);
    expect(validateJournalRow(row({ classes: ['shell.network', 'made.up'] as never }))).toBe(false);
    expect(validateJournalRow(row({ tool: 'mcp__server__tool' as never }))).toBe(false);
    expect(validateJournalRow(row({ classes: ['shell.network', 'shell.network'] }))).toBe(false);
  });

  it('keeps pre and post rows apart', () => {
    expect(validateJournalRow(row({ decision: null }))).toBe(false);
    expect(validateJournalRow(row({ scan: 'suspect' }))).toBe(false);
    expect(validateJournalRow(row({ phase: 'post', decision: 'allow', scan: 'suspect' }))).toBe(
      false,
    );
    expect(validateJournalRow(row({ phase: 'post', decision: null, scan: null }))).toBe(false);
  });

  it('refuses a bad sequence number, stamp, digest or rule id', () => {
    expect(validateJournalRow(row({ seq: 0 }))).toBe(false);
    expect(validateJournalRow(row({ seq: 1.5 }))).toBe(false);
    expect(validateJournalRow(row({ at: 'yesterday' }))).toBe(false);
    expect(validateJournalRow(row({ evidenceSha: 'abc' }))).toBe(false);
    expect(validateJournalRow(row({ ruleId: 'has space and /path' }))).toBe(false);
  });
});

describe('journal tail', () => {
  it('accepts every cursor state', () => {
    for (const cursor of ['start', 'ok', 'gap', 'reset'] as const)
      expect(validateJournalTail(tail({ cursor }))).toBe(true);
  });

  it('accepts a missing or refused journal only with no rows and no head', () => {
    expect(
      validateJournalTail(tail({ state: 'missing', rows: [], head: null, cursor: 'start' })),
    ).toBe(true);
    expect(
      validateJournalTail(tail({ state: 'refused', rows: [], head: null, cursor: 'start' })),
    ).toBe(true);
    expect(validateJournalTail(tail({ state: 'missing' }))).toBe(false);
  });

  it('keeps rows in order and bounded', () => {
    expect(validateJournalTail(tail({ rows: [row({ seq: 9 }), row({ seq: 8 })] }))).toBe(false);
    expect(validateJournalTail(tail({ rows: [row({ seq: 8 }), row({ seq: 8 })] }))).toBe(false);
    const many = Array.from({ length: MAX_TAIL_ROWS + 1 }, (_, i) => row({ seq: i + 1 }));
    expect(
      validateJournalTail(
        tail({ rows: many, head: { seq: MAX_TAIL_ROWS + 1, lineSha: sha('c') } }),
      ),
    ).toBe(false);
  });

  it('refuses a head older than the rows it came with', () => {
    expect(validateJournalTail(tail({ head: { seq: 3, lineSha: sha('b') } }))).toBe(false);
  });

  it('requires limitations and refuses extra keys', () => {
    expect(validateJournalTail(tail({ limitations: [] }))).toBe(false);
    expect(validateJournalTail({ ...tail(), blocked: 3 })).toBe(false);
  });
});

describe('tail request', () => {
  it('accepts a start and a cursor token', () => {
    expect(validateTailRequest({ after: null })).toBe(true);
    expect(validateTailRequest({ after: `5.${sha('d')}` })).toBe(true);
  });

  it('round-trips a cursor through its token', () => {
    const cursor = { seq: 12345, lineSha: sha('e') };
    expect(parseCursorToken(cursorToken(cursor))).toEqual(cursor);
  });

  it('refuses anything else: extra keys, objects, paths, limits, bad tokens', () => {
    expect(validateTailRequest({})).toBe(false);
    expect(validateTailRequest({ after: null, limit: 5000 })).toBe(false);
    expect(validateTailRequest({ after: null, path: '/etc/passwd' })).toBe(false);
    expect(validateTailRequest({ after: { seq: 5, lineSha: sha('d') } })).toBe(false);
    for (const token of [
      '0.' + sha('d'),
      '05.' + sha('d'),
      '5.' + 'xyz',
      '5',
      '5.' + sha('D'),
      `5.${sha('d')}x`,
      '-5.' + sha('d'),
      `${'9'.repeat(17)}.${sha('d')}`,
      ' 5.' + sha('d'),
    ])
      expect(validateTailRequest({ after: token }), token).toBe(false);
    expect(validateTailRequest(null)).toBe(false);
  });
});

describe('journal summary', () => {
  it('accepts a window with counts and notable rows', () => {
    expect(validateJournalSummary(summary())).toBe(true);
  });

  it('accepts an empty window', () => {
    expect(
      validateJournalSummary(
        summary({
          state: 'missing',
          window: { rows: 0, first: null, last: null, truncated: false },
          counts: { allow: 0, ask: 0, deny: 0, suspect: 0 },
          tools: {},
          classes: [],
          notable: [],
        }),
      ),
    ).toBe(true);
  });

  it('refuses counts that exceed the window and notable rows that are not notable', () => {
    expect(
      validateJournalSummary(summary({ counts: { allow: 99, ask: 1, deny: 1, suspect: 1 } })),
    ).toBe(false);
    expect(
      validateJournalSummary(
        summary({ notable: [row({ decision: 'allow', ruleId: null, classes: [] })] }),
      ),
    ).toBe(false);
  });

  it('refuses an unknown tool, an unknown class and extra keys', () => {
    expect(validateJournalSummary(summary({ tools: { 'raw-tool': 1 } as never }))).toBe(false);
    expect(
      validateJournalSummary(summary({ classes: [{ class: 'made.up', count: 1 }] as never })),
    ).toBe(false);
    expect(validateJournalSummary({ ...summary(), score: 92 })).toBe(false);
  });
});

describe('the days of a summary', () => {
  const days = summary().days;
  it('are seven local days, oldest first', () => {
    expect(validateJournalSummary(summary())).toBe(true);
    expect(validateJournalSummary(summary({ days: days.slice(1) }))).toBe(false);
    expect(validateJournalSummary(summary({ days: [...days].reverse() }))).toBe(false);
    expect(
      validateJournalSummary(
        summary({ days: days.map((d, i) => (i === 3 ? { ...d, date: '2026-10-2' } : d)) }),
      ),
    ).toBe(false);
  });

  it('are days of the calendar, one after another', () => {
    const at = (i: number, date: string) => days.map((d, j) => (j === i ? { ...d, date } : d));
    expect(validateJournalSummary(summary({ days: at(3, '2026-02-31') }))).toBe(false);
    expect(validateJournalSummary(summary({ days: at(6, '2026-10-28') }))).toBe(false);
    expect(validateJournalSummary(summary({ days: at(0, '2025-10-21') }))).toBe(false);
  });

  it('count no more of a kind than the window read', () => {
    const many = days.map((d) => ({ ...d, allow: 2 }));
    expect(validateJournalSummary(summary({ days: many }))).toBe(false);
    expect(validateJournalSummary(summary({ days: days.map((d) => ({ ...d, deny: -1 })) }))).toBe(
      false,
    );
    // Within the window's twelve rows, but more denials than the window has.
    const denied = days.map((d, i) => (i === 6 ? { ...d, deny: 2 } : d));
    expect(validateJournalSummary(summary({ days: denied }))).toBe(false);
  });

  it('count nothing on a day older than the part read', () => {
    const unread = days.map((d, i) => (i === 0 ? { ...d, read: 'none' as const } : d));
    expect(validateJournalSummary(summary({ days: unread, daysComplete: false }))).toBe(true);
    const counted = unread.map((d, i) => (i === 0 ? { ...d, allow: 1 } : d));
    expect(validateJournalSummary(summary({ days: counted, daysComplete: false }))).toBe(false);
  });

  it('are complete only where every day was read whole and every line could be read', () => {
    expect(validateJournalSummary(summary({ daysComplete: false }))).toBe(false);
    const part = days.map((d, i) => (i === 0 ? { ...d, read: 'part' as const } : d));
    expect(validateJournalSummary(summary({ days: part, daysComplete: false }))).toBe(true);
    expect(validateJournalSummary(summary({ days: part, daysComplete: true }))).toBe(false);
    expect(validateJournalSummary(summary({ unreadable: 2, daysComplete: true }))).toBe(false);
    expect(validateJournalSummary(summary({ unreadable: 2, daysComplete: false }))).toBe(true);
    const { daysComplete: _, ...without } = summary();
    expect(validateJournalSummary(without)).toBe(false);
  });

  it('are named by the local date of a moment', () => {
    const moment = new Date(2026, 9, 27, 23, 59);
    expect(localDate(moment)).toBe('2026-10-27');
  });
});

describe('what was recorded since a moment', () => {
  const since = (over: Partial<JournalSince> = {}): JournalSince => ({
    schema: 'stroq-journal-since/1',
    source: 'local',
    generatedAt: '2026-10-27T10:00:01.000Z',
    state: 'ready',
    since: '2026-10-27T09:00:00.000Z',
    counts: { allow: 3, ask: 1, deny: 0, suspect: 1 },
    complete: true,
    unreadable: 0,
    limitations: [...JOURNAL_LIMITATIONS],
    ...over,
  });

  it('is a closed answer', () => {
    expect(validateJournalSince(since())).toBe(true);
    expect(validateJournalSince({ ...since(), extra: 1 })).toBe(false);
    expect(validateJournalSince(since({ since: 'yesterday' }))).toBe(false);
    expect(
      validateJournalSince(since({ counts: { allow: -1, ask: 0, deny: 0, suspect: 0 } })),
    ).toBe(false);
    expect(validateJournalSince(since({ limitations: [] }))).toBe(false);
  });

  it('is about a moment that has passed', () => {
    expect(validateJournalSince(since({ since: '2026-10-27T10:04:00.000Z' }))).toBe(true);
    expect(validateJournalSince(since({ since: '2026-10-27T10:06:00.000Z' }))).toBe(false);
  });

  it('counts only in a journal that was read, and is complete only where every line was', () => {
    const none = { allow: 0, ask: 0, deny: 0, suspect: 0 };
    expect(validateJournalSince(since({ state: 'missing', counts: none }))).toBe(true);
    expect(validateJournalSince(since({ state: 'missing' }))).toBe(false);
    expect(validateJournalSince(since({ state: 'refused', counts: none }))).toBe(false);
    expect(validateJournalSince(since({ state: 'refused', counts: none, complete: false }))).toBe(
      true,
    );
    expect(validateJournalSince(since({ unreadable: 3 }))).toBe(false);
    expect(validateJournalSince(since({ unreadable: 3, complete: false }))).toBe(true);
  });

  it('is asked with a moment and nothing else', () => {
    expect(validateSinceRequest({ since: '2026-10-27T09:00:00.000Z' })).toBe(true);
    expect(validateSinceRequest({ since: '2026-10-27T09:00:00Z' })).toBe(false);
    expect(validateSinceRequest({ since: '2026-10-27T09:00:00.000Z', after: null })).toBe(false);
    expect(validateSinceRequest(null)).toBe(false);
  });
});

describe('row wording', () => {
  it('says what the agent did and what Stroq did, in plain words', () => {
    expect(describeRow(row())).toMatchObject({
      title: 'Run a command',
      verdict: 'Denied',
      tone: 'red',
    });
    expect(describeRow(row({ decision: 'allow', ruleId: null, classes: [] }))).toMatchObject({
      verdict: 'Allowed',
      tone: 'green',
    });
    expect(
      describeRow(
        row({ decision: 'ask', ruleId: 'ask-destructive', classes: ['shell.destructive'] }),
      ),
    ).toMatchObject({
      verdict: 'Asked you',
      tone: 'orange',
    });
    expect(
      describeRow(
        row({
          phase: 'post',
          decision: null,
          scan: 'suspect',
          tool: 'file-read',
          ruleId: null,
          classes: [],
        }),
      ),
    ).toMatchObject({ title: 'Read a file', verdict: 'Flagged', tone: 'orange' });
  });

  it('never says blocked, safe or protected', () => {
    for (const decision of ['allow', 'ask', 'deny'] as const)
      expect(JSON.stringify(describeRow(row({ decision })))).not.toMatch(/blocked|safe|protected/i);
  });

  it('names a custom rule without exposing its id', () => {
    const custom = describeRow(row({ ruleId: null }));
    expect(custom.detail).toMatch(/your own policy/i);
  });
});

describe('applying a tail to the rows on screen', () => {
  const entry = (seq: number, fresh = false) => ({ row: row({ seq }), fresh });
  const head = { seq: 9, lineSha: sha('b') };

  it('puts new rows on top, newest first, and marks only them as fresh', () => {
    const result = applyTail(
      [entry(2), entry(1)],
      tail({ rows: [row({ seq: 3 }), row({ seq: 4 })], head }),
      300,
    );
    expect(result.entries.map((e) => [e.row.seq, e.fresh])).toEqual([
      [4, true],
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(result.gap).toBe(false);
  });

  it('replaces the list on a start or a reset, with nothing marked fresh', () => {
    for (const cursor of ['start', 'reset'] as const) {
      const result = applyTail(
        [entry(2)],
        tail({ cursor, rows: [row({ seq: 5 }), row({ seq: 6 })], head }),
        300,
      );
      expect(result.entries.map((e) => [e.row.seq, e.fresh])).toEqual([
        [6, false],
        [5, false],
      ]);
      expect(result.gap).toBe(false);
    }
  });

  it('replaces the list on a gap and says so', () => {
    const result = applyTail(
      [entry(2)],
      tail({ cursor: 'gap', rows: [row({ seq: 8 })], head }),
      300,
    );
    expect(result.entries.map((e) => e.row.seq)).toEqual([8]);
    expect(result.gap).toBe(true);
  });

  it('keeps what is on screen when nothing new arrived', () => {
    const current = [entry(2), entry(1)];
    expect(applyTail(current, tail({ rows: [], head }), 300).entries).toEqual(
      current.map((e) => ({ ...e, fresh: false })),
    );
  });

  it('empties the list when the journal cannot be read', () => {
    expect(
      applyTail([entry(2)], tail({ state: 'missing', rows: [], head: null, cursor: 'start' }), 300)
        .entries,
    ).toEqual([]);
  });

  it('keeps at most the limit, dropping the oldest', () => {
    const current = Array.from({ length: 5 }, (_, i) => entry(5 - i));
    const result = applyTail(current, tail({ rows: [row({ seq: 6 }), row({ seq: 7 })], head }), 4);
    expect(result.entries.map((e) => e.row.seq)).toEqual([7, 6, 5, 4]);
  });
});
