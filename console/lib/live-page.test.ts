import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JournalRow, JournalSummary } from './journal-view';

const sha = (n: number) => n.toString(16).padStart(64, '0');
const S1 = 'session-aaaaaaaaaaaa1111';
const S2 = 'session-bbbbbbbbbbbb2222';

const seen = vi.hoisted(() => ({
  platform: { ready: true, loading: false, error: null, localAccess: true } as Record<
    string,
    unknown
  >,
  search: '',
  live: {} as Record<string, unknown>,
  incidents: null as unknown,
}));

vi.mock('@/components/platform-provider', () => ({ usePlatform: () => seen.platform }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(seen.search),
  usePathname: () => '/live/',
}));
vi.mock('next/link', async () => {
  const { createElement: h } = await import('react');
  return { default: ({ href, children, ...rest }: any) => h('a', { href, ...rest }, children) };
});
vi.mock('@/components/copy-command', async () => {
  const { createElement: h } = await import('react');
  return {
    CopyCommand: ({ command }: { command: string }) => h('code', { 'data-copy': command }, command),
  };
});
vi.mock('@/components/platform/use-journal-live', () => ({ useJournalLive: () => seen.live }));
vi.mock('@/components/platform/live-receipt', () => ({ LiveReceipt: () => null }));
vi.mock('@/components/platform/use-incidents', () => ({
  useIncidentEvidence: () => ({
    comparisons: [],
    compare: () => undefined,
    state: seen.incidents,
    busy: seen.incidents ? null : 'load',
    error: null,
  }),
}));
vi.mock('@/components/platform/use-incident-recorded-evidence', () => ({
  useIncidentRecordedEvidence: () => ({}),
}));
vi.mock('@/components/platform/incident-comparison', async () => {
  const { createElement: h } = await import('react');
  return { IncidentComparisonPanel: () => h('section', null, 'Policy comparison panel') };
});
vi.mock('@/components/platform/incident-recorded-evidence', async () => {
  const { createElement: h } = await import('react');
  return { IncidentRecordedEvidencePanel: () => h('section', null, 'Recorded evidence panel') };
});

import { LivePage } from '@/components/platform/live-view';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

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
const journal: JournalRow[] = [
  row(9, {
    decision: 'deny',
    ruleId: 'STROQ-0042',
    session: S2,
    classes: ['shell.exec_encoded'],
  }),
  row(8, { decision: 'ask', session: S1 }),
  row(7, { decision: null, phase: 'post', scan: 'suspect', tool: 'web', session: S1 }),
  row(6, { decision: 'allow', session: S2 }),
];
const summary = {
  window: { rows: 4, first: journal[3]!.at, last: journal[0]!.at, truncated: false },
  counts: { allow: 1, ask: 1, deny: 1, suspect: 1 },
  days: [{ date: '2026-11-02', read: 'all', allow: 1, ask: 1, deny: 1, suspect: 1 }],
  unreadable: 0,
} as unknown as JournalSummary;

function live(over: Record<string, unknown> = {}) {
  return {
    localAccess: true,
    rows: journal.map((entry) => ({ row: entry, fresh: false })),
    summary,
    state: 'live',
    error: null,
    gap: false,
    paused: false,
    polledAt: Date.parse('2026-11-02T10:10:00.000Z'),
    togglePause: () => undefined,
    retry: () => undefined,
    notify: 'off',
    setNotifications: async () => undefined,
    ...over,
  };
}
const html = () => renderToStaticMarkup(createElement(LivePage));

beforeEach(() => {
  seen.platform = { ready: true, loading: false, error: null, localAccess: true };
  seen.search = '';
  seen.live = live();
  seen.incidents = null;
});

describe('the Live screen', () => {
  it('says plainly that nothing is connected', () => {
    seen.platform = { ready: true, loading: false, error: null, localAccess: false };
    const out = text(html());
    expect(out).toContain('Run npx @stroq/cli console to open this page with your data.');
    expect(out).not.toContain('Recorded actions');
  });

  it('puts the counts on top and the filters over the feed, with how many rows each keeps', () => {
    const out = html();
    const words = text(out);
    expect(words).toContain('Allowed');
    expect(words).toContain('Asked you');
    for (const [label, n] of [
      ['All', 4],
      ['Denied', 1],
      ['Asked', 1],
      ['Flagged', 1],
    ] as const)
      expect(words).toContain(`${label} ${n}`);
    expect(out.indexOf('Recorded actions by decision')).toBeLessThan(
      out.indexOf('aria-label="Show"'),
    );
    expect(out).toContain('aria-pressed="true"');
  });

  it('offers a session, a day and a search, and merges Activity, Sessions and Overview', () => {
    const out = html();
    expect(out).toContain('Filter by session');
    expect(out).toContain('Session …1111 · 2 rows');
    expect(out).toContain('Session …2222 · 2 rows');
    expect(out).toContain('<option value="2026-11-02">2026-11-02</option>');
    expect(out).toContain('Search the rows on screen');
  });

  it('lists the rows newest first, closed, each a button that can open its chain', () => {
    const out = html();
    expect(out.match(/aria-expanded="false"/g)).toHaveLength(4);
    expect(out).not.toContain('class="live-chain"');
    expect(out.indexOf('event-9')).toBeLessThan(out.indexOf('event-6'));
  });

  it('filters by the decision, the session and words', () => {
    seen.search = 'show=denied';
    expect(html().match(/aria-expanded=/g)).toHaveLength(1);
    seen.search = `session=${S1}`;
    expect(html().match(/aria-expanded=/g)).toHaveLength(2);
    seen.search = 'q=STROQ-0042';
    expect(html().match(/aria-expanded=/g)).toHaveLength(1);
    seen.search = 'show=asked&session=' + S2;
    const out = html();
    expect(out).not.toContain('aria-expanded');
    expect(text(out)).toContain('No row matches');
    expect(text(out)).toContain('Reset filters');
  });

  it('opens the chain of a denied row: what was read, what it did, the decision, the rule', () => {
    seen.search = `event=${sha(9)}`;
    seen.incidents = { incidents: [{ evidenceSha: sha(9) }] };
    const out = html();
    const words = text(out);
    expect(out.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(words).toContain('Encoded execution.');
    for (const heading of ['What the agent read', 'What it did', 'Decision', 'Rule'])
      expect(words).toContain(heading);
    expect(words).toContain('Denied');
    expect(out).toContain('href="/policies/?find=STROQ-0042#reference"');
    expect(words).toContain('Recorded evidence panel');
    expect(words).toContain('Policy comparison panel');
    expect(out).toContain('data-copy="stroq why --seq 9"');
    expect(out).toContain('data-copy="stroq untaint --session &lt;id&gt;"');
  });

  it('opens an event named by its number, from an older link', () => {
    seen.search = 'event=8';
    expect(html().match(/aria-expanded="true"/g)).toHaveLength(1);
  });

  it('says what the same session had read before an asked row', () => {
    seen.search = `event=${sha(8)}`;
    const words = text(html());
    expect(words).toContain('Earlier in this session one result looked like instructions');
    expect(words).toContain('it does not say one caused the other');
  });

  it('says a flagged result is not a decision, and an allowed row has no evidence panel', () => {
    seen.search = `event=${sha(7)}`;
    expect(text(html())).toContain('this is not a decision');
    seen.search = `event=${sha(6)}`;
    const out = html();
    expect(text(out)).toContain('Your own policy, or a built-in default');
    expect(out).not.toContain('Recorded evidence panel');
  });

  it('says so when the named event is not among the rows on screen', () => {
    seen.search = `event=${sha(123)}`;
    const out = text(html());
    expect(out).toContain('That event is not in the newest rows on screen');
    expect(out).toContain('stroq why');
  });

  it('keeps the empty and refused states plain', () => {
    seen.live = live({ rows: [], state: 'missing', summary: null });
    expect(text(html())).toContain('No journal yet');
    seen.live = live({ rows: [], state: 'refused', summary: null });
    expect(text(html())).toContain('The journal could not be read safely');
  });

  it('never calls a decision blocked, secure or safe', () => {
    seen.search = `event=${sha(9)}`;
    expect(text(html())).not.toMatch(/\b(blocked|secure[sd]?|safe|protected)\b/i);
  });
});
