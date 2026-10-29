import { describe, expect, it } from 'vitest';
import { CALLS, dayLabel } from './data';
import {
  NO_FILTER,
  filterCalls,
  filterToSearch,
  groupByDay,
  parseFilter,
  toAgentFilter,
  toDecisionFilter,
} from './filter';
import { STATUS } from './status';

describe('parseFilter', () => {
  it('reads a known decision, agent and query', () => {
    const filter = parseFilter(new URLSearchParams('decision=block&agent=Cursor&q=push'));
    expect(filter).toEqual({ decision: 'block', agent: 'Cursor', query: 'push' });
  });

  it('falls back to all for values it does not know', () => {
    const filter = parseFilter(new URLSearchParams('decision=__proto__&agent=<script>'));
    expect(filter).toEqual(NO_FILTER);
  });

  it('caps a very long query', () => {
    const filter = parseFilter(new URLSearchParams(`q=${'a'.repeat(5000)}`));
    expect(filter.query).toHaveLength(200);
  });
});

describe('filterToSearch', () => {
  it('leaves a clean address for the default view', () => {
    expect(filterToSearch(NO_FILTER)).toBe('');
  });

  it('round-trips through parseFilter', () => {
    const filter = { decision: 'ask', agent: 'Claude Code', query: 'pull request' } as const;
    expect(parseFilter(new URLSearchParams(filterToSearch(filter)))).toEqual(filter);
  });
});

describe('filterCalls', () => {
  it('returns every call with no filter', () => {
    expect(filterCalls(CALLS, NO_FILTER)).toHaveLength(CALLS.length);
  });

  it('keeps only one decision', () => {
    const asked = filterCalls(CALLS, { ...NO_FILTER, decision: 'ask' });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((call) => call.decision === 'ask')).toBe(true);
  });

  it('matches the query in the raw command or the label, ignoring case', () => {
    expect(filterCalls(CALLS, { ...NO_FILTER, query: 'FORCE' }).map((c) => c.id)).toEqual([
      '18172',
    ]);
    expect(filterCalls(CALLS, { ...NO_FILTER, query: 'left-pad' }).map((c) => c.id)).toEqual([
      '18120',
    ]);
  });

  it('does not change the input', () => {
    const before = CALLS.map((c) => c.id);
    filterCalls(CALLS, { ...NO_FILTER, decision: 'block' });
    expect(CALLS.map((c) => c.id)).toEqual(before);
  });
});

describe('groupByDay', () => {
  it('groups consecutive calls under their day, in order', () => {
    const groups = groupByDay(CALLS);
    expect(groups.map((g) => dayLabel(g.date))).toEqual(['Today', 'Tue']);
    expect(groups.reduce((n, g) => n + g.calls.length, 0)).toBe(CALLS.length);
  });

  it('keeps two Tuesdays a week apart as two groups', () => {
    const first = { ...CALLS[10]!, id: 'a', date: '2026-10-13' };
    const second = { ...CALLS[10]!, id: 'b', date: '2026-10-20' };
    const groups = groupByDay([first, second]);
    expect(groups.map((g) => dayLabel(g.date))).toEqual(['Tue', 'Tue']);
    expect(new Set(groups.map((g) => g.date)).size).toBe(2);
  });

  it("handles a day's worth of calls without slowing down", () => {
    const many = Array.from({ length: 50_000 }, (_, i) => ({ ...CALLS[0]!, id: String(i) }));
    const started = performance.now();
    expect(groupByDay(many)).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('returns nothing for nothing', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('toDecisionFilter and toAgentFilter', () => {
  it('pass known values and turn anything else into all', () => {
    expect(toDecisionFilter('ask')).toBe('ask');
    expect(toDecisionFilter('nope')).toBe('all');
    expect(toAgentFilter('Cursor')).toBe('Cursor');
    expect(toAgentFilter('')).toBe('all');
  });
});

describe('dayLabel', () => {
  it('says Today for today and a weekday for older dates', () => {
    expect(dayLabel('2026-10-21')).toBe('Today');
    expect(dayLabel('2026-10-20')).toBe('Tue');
  });
});

describe('STATUS', () => {
  it('gives every status words, so colour never stands alone', () => {
    for (const spec of Object.values(STATUS)) expect(spec.label.trim()).not.toBe('');
  });
});
