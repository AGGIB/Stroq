import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const seen = vi.hoisted(() => ({
  platform: { ready: true, loading: false, error: null, localAccess: true } as Record<
    string,
    unknown
  >,
  card: { localAccess: true, state: null, problem: null, check: () => undefined } as Record<
    string,
    unknown
  >,
  agents: null as unknown,
}));

vi.mock('@/components/platform-provider', () => ({ usePlatform: () => seen.platform }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/',
  useRouter: () => ({ push: () => undefined }),
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
vi.mock('@/components/platform/use-card', () => ({ useCard: () => seen.card }));
vi.mock('@/components/platform/use-protection-verdict', () => ({
  useProtectionVerdict: () => ({
    localAccess: true,
    agents: seen.agents,
    journal: null,
    failed: false,
    loading: false,
    reload: () => undefined,
  }),
}));
vi.mock('@/components/platform/posture-strip', () => ({ PostureStrip: () => null }));
vi.mock('@/components/platform/setup-checks', async () => {
  const { createElement: h } = await import('react');
  return {
    SetupChecks: () => h('details', { id: 'setup-checks' }, h('summary', null, 'Setup checks')),
  };
});

import { CheckPage } from '@/components/platform/check';
import type { CardMoment, CardState } from '@/lib/card';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const html = () => renderToStaticMarkup(createElement(CheckPage));

const moment = (
  n: number,
  kind: CardMoment['kind'],
  line: string,
  next: string[] = [],
): CardMoment => ({
  n,
  kind,
  line,
  groups: [
    {
      title: 'What your agent read',
      rows: [
        ['Where', 'README.md'],
        ['', 'It said run the script.'],
      ],
    },
  ],
  next,
});

function state(
  over: Partial<CardState> = {},
  result: Partial<CardState['result'] & object> | null = {},
): Mutable<CardState> {
  const found = [
    moment(1, 'told-by-text', 'A file told your agent to download and run a script. It did.'),
    moment(2, 'key-sent', 'Your agent sent STRIPE_SECRET_KEY to hooks.example.invalid.'),
    moment(3, 'autorun-repo', '~/shop runs code as soon as an agent opens it.', [
      'stroq inspect ~/shop',
    ]),
    moment(4, 'key-seen', 'The AI saw AWS_SECRET_ACCESS_KEY.'),
  ];
  return {
    schema: 'stroq-card-state/1',
    engine: { available: true, version: '0.29.0' },
    status: 'done',
    startedAt: '2026-11-03T10:00:00.000Z',
    finishedAt: '2026-11-03T10:00:20.000Z',
    error: null,
    result:
      result === null
        ? null
        : {
            schema: 'stroq-card-view/1',
            version: '0.29.0',
            generated: '2026-11-03T10:00:20.000Z',
            days: 30,
            owl: 'alert',
            view: {
              kind: 'card',
              title: 'Hoo checked 30 days of your agent sessions',
              subtitle: '1,756 sessions · Claude Code and Codex · this machine',
              rows: [
                { id: 'commands', count: 31_785, text: 'commands your agent ran' },
                {
                  id: 'told',
                  count: 1,
                  text: 'came from text it read: a README, page, issue or tool result',
                },
                { id: 'keys', count: 1, text: 'key that left this machine' },
                { id: 'autorun', count: 1, text: 'repo runs code as soon as an agent opens it' },
              ],
              notes: ['Checked 812 of 1,756 sessions, newest first; run again to check the rest.'],
              nothing: null,
              moments: found.slice(0, 3).map(({ n, line }) => ({ n, line })),
              next: { label: 'Stop this next time:', command: 'npx @stroq/cli init' },
            },
            moments: found,
            shown: 3,
            ...result,
          },
    ...over,
  };
}

beforeEach(() => {
  seen.platform = { ready: true, loading: false, error: null, localAccess: true };
  seen.card = { localAccess: true, state: null, problem: null, check: () => undefined };
  seen.agents = null;
});

describe('the Check screen', () => {
  it('says plainly that nothing is connected, with the command to connect, and shows no card', () => {
    seen.platform = { ready: true, loading: false, error: null, localAccess: false };
    const out = text(html());
    expect(out).toContain('Run npx @stroq/cli console to open this page with your data.');
    expect(out).not.toMatch(/Hoo checked|Worth a look/);
  });

  it('waits for the engine without inventing a card', () => {
    const out = text(html());
    expect(out).toContain('Connecting to the local engine');
    expect(out).not.toContain('Hoo checked');
  });

  it('says what it is doing while the first card is made', () => {
    seen.card = { ...seen.card, state: state({ status: 'running', finishedAt: null }, null) };
    const out = html();
    expect(text(out)).toContain('Hoo is reading your agent sessions on this machine');
    expect(out).toContain('src="/hoo/idle.svg"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^]*Check again/);
  });

  it('shows the terminal’s card: title, the four counts, the notes and the owl that found something', () => {
    seen.card = { ...seen.card, state: state() };
    const out = html();
    const words = text(out);
    expect(words).toContain('Hoo checked 30 days of your agent sessions');
    expect(words).toContain('1,756 sessions · Claude Code and Codex · this machine');
    expect(words).toContain('31,785 commands your agent ran');
    expect(words).toContain(
      'Checked 812 of 1,756 sessions, newest first; run again to check the rest.',
    );
    expect(out).toContain('src="/hoo/alert.svg"');
    for (const id of ['commands', 'told', 'keys', 'autorun']) expect(out).toContain(`id="${id}"`);
    expect(words).toContain('To look inside one, run stroq inspect &lt;folder&gt;');
    expect(words).toContain('version 0.29.0');
  });

  it('lists the moments, three first and the rest folded, each with its evidence and `stroq show N`', () => {
    seen.card = { ...seen.card, state: state() };
    const out = html();
    expect(text(out)).toContain('Worth a look');
    for (const n of [1, 2, 3, 4]) {
      expect(out).toContain(`id="moment-${n}"`);
      expect(out).toContain(`data-copy="stroq show ${n}"`);
    }
    expect(out).toContain('data-copy="stroq inspect ~/shop"');
    expect(text(out)).toContain('1 more moment');
    expect(text(out)).toContain('It said run the script.');
    expect(out.indexOf('id="moment-3"')).toBeLessThan(out.indexOf('class="check-more"'));
    expect(out.indexOf('class="check-more"')).toBeLessThan(out.indexOf('id="moment-4"'));
  });

  it('says there is nothing to look at, with the happy owl, and points at the attack demo', () => {
    const base = state();
    const clean = state({}, null);
    clean.result = {
      ...base.result!,
      owl: 'happy',
      moments: [],
      view: {
        kind: 'card',
        title: 'Hoo checked 30 days of your agent sessions',
        subtitle: '12 sessions · Claude Code · this machine',
        rows: base.result!.view.kind === 'card' ? base.result!.view.rows : [],
        notes: [],
        nothing: 'Nothing worth a look in these sessions.',
        moments: [],
        next: { label: 'See what Stroq stops:', command: 'npx @stroq/cli attack' },
      },
    };
    seen.card = { ...seen.card, state: clean };
    const out = html();
    expect(text(out)).toContain('Nothing worth a look in these sessions.');
    expect(text(out)).not.toContain('Worth a look');
    expect(out).toContain('src="/hoo/happy.svg"');
    expect(out).toContain('data-copy="npx @stroq/cli attack"');
  });

  it('says where it looked when there are no sessions', () => {
    const none = state();
    none.result = {
      ...none.result!,
      owl: 'idle',
      moments: [],
      view: {
        kind: 'nothing-to-read',
        title: 'Hoo found no agent sessions in the last 30 days.',
        looked: 'Looked for Claude Code in ~/.claude/projects and Codex in ~/.codex/sessions.',
        next: { label: 'See what Stroq stops:', command: 'npx @stroq/cli attack' },
      },
    };
    seen.card = { ...seen.card, state: none };
    const out = html();
    expect(text(out)).toContain('Hoo found no agent sessions in the last 30 days.');
    expect(text(out)).toContain('Looked for Claude Code in ~/.claude/projects');
    expect(out).toContain('src="/hoo/idle.svg"');
  });

  it('keeps the last card while the next is made, and says so', () => {
    seen.card = { ...seen.card, state: state({ status: 'running' }) };
    const out = html();
    expect(text(out)).toContain('Checking again. The card below is the last one.');
    expect(text(out)).toContain('Hoo checked 30 days');
    expect(out).toContain('aria-busy="true"');
  });

  it('words a failed run, and keeps the card it had', () => {
    seen.card = { ...seen.card, state: state({ status: 'failed', error: 'deadline-exceeded' }) };
    const out = text(html());
    expect(out).toContain('Checking took longer than two and a half minutes');
    expect(out).toContain('The card below is the last one that was made.');
    seen.card = {
      ...seen.card,
      state: state({ status: 'failed', error: 'engine-unavailable' }, null),
    };
    expect(text(html())).toContain('The Stroq engine is not built');
  });

  it('has the one fix line, the agents section and the setup checks, closed', () => {
    seen.card = { ...seen.card, state: state() };
    const out = html();
    expect(out).toContain('data-copy="npx @stroq/cli init"');
    expect(text(out)).toContain('Your agents');
    expect(out).toContain('id="setup-checks"');
    expect(text(out)).toContain('Nothing is sent anywhere');
  });

  it('never says the check blocks or secures anything', () => {
    seen.card = { ...seen.card, state: state() };
    expect(text(html())).not.toMatch(/\b(protect\w*|secur\w*|safe|blocks?)\b/i);
  });
});
