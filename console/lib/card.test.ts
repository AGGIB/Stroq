import { describe, expect, it } from 'vitest';
import {
  CARD_ERRORS,
  CARD_ERROR_MESSAGES,
  STALE_MS,
  checkedAgo,
  owlFor,
  owlSrc,
  shouldStart,
  validateCardState,
  type CardState,
} from './card';

const NOW = Date.parse('2026-11-03T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const moment = (n: number) => ({
  n,
  kind: 'key-sent',
  line: 'Your agent sent STRIPE_SECRET_KEY to hooks.example.invalid. Treat that key as leaked.',
  groups: [
    {
      title: 'What happened',
      rows: [
        ['Key', 'STRIPE_SECRET_KEY'],
        ['', 'Sent once.'],
      ],
    },
  ],
  next: ['stroq sent --here'],
});

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'stroq-card-state/1',
    engine: { available: true, version: '0.29.0' },
    status: 'done',
    startedAt: iso(NOW - 30_000),
    finishedAt: iso(NOW - 5_000),
    error: null,
    result: {
      schema: 'stroq-card-view/1',
      version: '0.29.0',
      generated: iso(NOW - 5_000),
      days: 30,
      owl: 'alert',
      view: {
        kind: 'card',
        title: 'Hoo checked 30 days of your agent sessions',
        subtitle: '12 sessions · Claude Code · this machine',
        rows: [
          { id: 'commands', count: 310, text: 'commands your agent ran' },
          {
            id: 'told',
            count: 1,
            text: 'came from text it read: a README, page, issue or tool result',
          },
          { id: 'keys', count: 1, text: 'key that left this machine' },
          { id: 'autorun', count: 0, text: 'repos run code as soon as an agent opens them' },
        ],
        notes: ['Checked 8 of 12 sessions, newest first; run again to check the rest.'],
        nothing: null,
        moments: [{ n: 1, line: moment(1).line }],
        next: { label: 'Stop this next time:', command: 'npx @stroq/cli init' },
      },
      moments: [moment(1)],
      shown: 3,
    },
    ...over,
  };
}

describe('the card state the engine returns', () => {
  it('accepts a finished card', () => {
    expect(validateCardState(state())).toBe(true);
  });

  it('accepts the states before there is a card', () => {
    expect(
      validateCardState(state({ status: 'idle', startedAt: null, finishedAt: null, result: null })),
    ).toBe(true);
    expect(
      validateCardState(state({ status: 'failed', error: 'deadline-exceeded', result: null })),
    ).toBe(true);
  });

  it('accepts a card for a machine with no sessions', () => {
    const none = state();
    (none.result as Record<string, unknown>).owl = 'idle';
    (none.result as Record<string, unknown>).moments = [];
    (none.result as Record<string, unknown>).view = {
      kind: 'nothing-to-read',
      title: 'Hoo found no agent sessions in the last 30 days.',
      looked: 'Looked for Claude Code in ~/.claude/projects and Codex in ~/.codex/sessions.',
      next: { label: 'See what Stroq stops:', command: 'npx @stroq/cli attack' },
    };
    expect(validateCardState(none)).toBe(true);
  });

  it.each([
    ['an unknown top-level field', { extra: 1 }],
    ['an unknown status', { status: 'paused' }],
    ['a date that is not one', { finishedAt: '2026-11-03' }],
    ['an error code it does not know', { error: 'ENOENT /Users/x' }],
    ['no engine facts', { engine: { available: true } }],
  ])('refuses %s', (_name, over) => {
    expect(validateCardState(state(over))).toBe(false);
  });

  it('refuses a card whose rows are not the four counts in order', () => {
    const bad = state();
    const view = (bad.result as { view: { rows: unknown[] } }).view;
    view.rows = [...view.rows].reverse();
    expect(validateCardState(bad)).toBe(false);
  });

  it('refuses a moment with a control character, an unknown kind or the wrong number', () => {
    for (const change of [
      (m: Record<string, unknown>) => (m.line = 'ok\u001b[31m red'),
      (m: Record<string, unknown>) => (m.kind = 'shell-command'),
      (m: Record<string, unknown>) => (m.n = 2),
      (m: Record<string, unknown>) => (m.extra = true),
      (m: Record<string, unknown>) => (m.next = ['a', 'b', 'c', 'd', 'e']),
    ]) {
      const bad = state();
      change((bad.result as { moments: Record<string, unknown>[] }).moments[0]!);
      expect(validateCardState(bad)).toBe(false);
    }
  });

  it('refuses a view that says there is nothing while moments are listed, and the other way round', () => {
    const said = state();
    (said.result as { view: Record<string, unknown> }).view.nothing =
      'Nothing worth a look in these sessions.';
    expect(validateCardState(said)).toBe(false);
    const silent = state();
    (silent.result as { view: Record<string, unknown> }).view.moments = [];
    expect(validateCardState(silent)).toBe(false);
  });

  it('words every error code and no other', () => {
    for (const code of CARD_ERRORS) expect(CARD_ERROR_MESSAGES[code].length).toBeGreaterThan(20);
    expect(Object.keys(CARD_ERROR_MESSAGES).sort()).toEqual([...CARD_ERRORS].sort());
    for (const message of Object.values(CARD_ERROR_MESSAGES))
      expect(message).not.toMatch(/\b(protect\w*|secur\w*|safe|blocked)\b/i);
  });
});

describe('what the screen does with a state', () => {
  const done = state() as unknown as CardState;
  it('shows the owl of the result, or the idle owl without one', () => {
    expect(owlFor(done)).toBe('alert');
    expect(owlFor(null)).toBe('idle');
    expect(owlFor({ ...done, result: null })).toBe('idle');
    expect(owlSrc('happy')).toBe('/hoo/happy.svg');
  });

  it('starts a run when nothing was made or the card is old, and not while one is going', () => {
    const idle = { ...done, status: 'idle', result: null, finishedAt: null } as CardState;
    expect(shouldStart(idle, NOW)).toBe(true);
    expect(shouldStart(done, NOW)).toBe(false);
    expect(shouldStart(done, NOW + STALE_MS + 10_000)).toBe(true);
    expect(shouldStart({ ...done, status: 'running' }, NOW + 2 * STALE_MS)).toBe(false);
    expect(shouldStart({ ...idle, engine: { available: false, version: null } }, NOW)).toBe(false);
    expect(shouldStart({ ...done, status: 'failed' }, NOW + 2 * STALE_MS)).toBe(false);
  });

  it('says how long ago in plain words', () => {
    expect(checkedAgo(iso(NOW - 10_000), NOW)).toBe('just now');
    expect(checkedAgo(iso(NOW - 4 * 60_000), NOW)).toBe('4 min ago');
    expect(checkedAgo(iso(NOW - 3 * 3_600_000), NOW)).toBe('3 h ago');
    expect(checkedAgo(iso(NOW - 4 * 86_400_000), NOW)).toBe('4 days ago');
  });
});
