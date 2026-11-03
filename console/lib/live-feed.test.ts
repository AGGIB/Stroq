import { describe, expect, it } from 'vitest';
import {
  chainCommands,
  dayOptions,
  filterRows,
  findEvent,
  hasEvidence,
  inShow,
  readBefore,
  sessionOptions,
  showCounts,
} from './live-feed';
import type { JournalRow, JournalSummary } from './journal-view';

const S1 = 'session-aaaaaaaaaaaa1111';
const S2 = 'session-bbbbbbbbbbbb2222';
const sha = (n: number) => n.toString(16).padStart(64, '0');

function row(seq: number, over: Partial<JournalRow> = {}): JournalRow {
  return {
    seq,
    at: `2026-11-02T10:${String(seq).padStart(2, '0')}:00.000Z`,
    phase: 'pre',
    decision: 'allow',
    scan: null,
    tool: 'shell',
    classes: [],
    ruleId: null,
    session: S1,
    evidenceSha: sha(seq),
    ...over,
  };
}
const rows: JournalRow[] = [
  row(9, { decision: 'deny', ruleId: 'STROQ-0042', session: S2 }),
  row(8, { decision: 'ask', session: S1 }),
  row(7, { decision: null, phase: 'post', scan: 'suspect', tool: 'web', session: S1 }),
  row(6, { decision: 'allow', session: S2 }),
  row(5, { decision: null, phase: 'post', scan: 'suspect', tool: 'file-read', session: S1 }),
  row(4, { decision: 'allow', session: S1 }),
];
const none = { show: 'all', session: null, date: null, text: '' } as const;

describe('the Live filters', () => {
  it('keep denied, asked and flagged rows apart, and flagged results are not decisions', () => {
    expect(rows.filter((r) => inShow(r, 'denied')).map((r) => r.seq)).toEqual([9]);
    expect(rows.filter((r) => inShow(r, 'asked')).map((r) => r.seq)).toEqual([8]);
    expect(rows.filter((r) => inShow(r, 'flagged')).map((r) => r.seq)).toEqual([7, 5]);
    expect(showCounts(rows)).toEqual({ all: 6, denied: 1, asked: 1, flagged: 2 });
  });

  it('combine a decision filter, a session, a day and words, and keep the order given', () => {
    expect(filterRows(rows, none).map((r) => r.seq)).toEqual([9, 8, 7, 6, 5, 4]);
    expect(filterRows(rows, { ...none, session: S1 }).map((r) => r.seq)).toEqual([8, 7, 5, 4]);
    expect(filterRows(rows, { ...none, show: 'flagged', session: S1 }).map((r) => r.seq)).toEqual([
      7, 5,
    ]);
    expect(filterRows(rows, { ...none, text: 'STROQ-0042' }).map((r) => r.seq)).toEqual([9]);
    expect(filterRows(rows, { ...none, text: 'use the web' }).map((r) => r.seq)).toEqual([7]);
    expect(filterRows(rows, { ...none, text: 'nothing like this' })).toEqual([]);
  });

  it('filter by the local day of a row', () => {
    const day = new Date(rows[0]!.at);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    expect(filterRows(rows, { ...none, date })).toHaveLength(6);
    expect(filterRows(rows, { ...none, date: '2020-01-01' })).toEqual([]);
  });
});

describe('finding an event', () => {
  it('takes the digest of its line, or the number of an older link', () => {
    expect(findEvent(rows, sha(8))?.seq).toBe(8);
    expect(findEvent(rows, '7')?.seq).toBe(7);
    expect(findEvent(rows, '123')).toBeNull();
    expect(findEvent(rows, sha(123))).toBeNull();
    expect(findEvent(rows, null)).toBeNull();
  });
});

describe('the offers of the filters', () => {
  it('lists the sessions on screen, the newest first, with a short name and a count', () => {
    expect(sessionOptions(rows)).toEqual([
      { id: S2, short: '2222', rows: 2, newest: rows[0]!.at },
      { id: S1, short: '1111', rows: 4, newest: rows[1]!.at },
    ]);
  });

  it('lists the days the journal read reaches, the newest first', () => {
    const summary = {
      days: [
        { date: '2026-10-31', read: 'none', allow: 0, ask: 0, deny: 0, suspect: 0 },
        { date: '2026-11-01', read: 'part', allow: 1, ask: 0, deny: 0, suspect: 0 },
        { date: '2026-11-02', read: 'all', allow: 5, ask: 1, deny: 1, suspect: 2 },
      ],
    } as unknown as JournalSummary;
    expect(dayOptions(summary)).toEqual([
      { date: '2026-11-02', read: 'all' },
      { date: '2026-11-01', read: 'part' },
    ]);
    expect(dayOptions(null)).toEqual([]);
  });
});

describe('the chain of a row', () => {
  it('says which flagged results the same session had before it, newest first, and how many there were', () => {
    const before = readBefore(rows, rows[1]!);
    expect(before.rows.map((r) => r.seq)).toEqual([7, 5]);
    expect(before.total).toBe(2);
    expect(readBefore(rows, rows[1]!, 1)).toMatchObject({ total: 2, rows: [{ seq: 7 }] });
    expect(readBefore(rows, rows[0]!)).toEqual({ rows: [], total: 0 });
    expect(readBefore(rows, rows[5]!)).toEqual({ rows: [], total: 0 });
  });

  it('asks for recorded evidence only where there is a finding', () => {
    expect(rows.filter(hasEvidence).map((r) => r.seq)).toEqual([9, 8, 7, 5]);
  });

  it('offers `stroq why` for the row and `stroq untaint` for the session', () => {
    expect(chainCommands(rows[1]!)).toEqual({
      why: 'stroq why --seq 8',
      untaint: 'stroq untaint --session <id>',
    });
  });
});
