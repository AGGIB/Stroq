import { describe, expect, it } from 'vitest';
import { buildCounts } from '../../src/sent/counts.js';
import type { Finding } from '../../src/sent/findings.js';
import { formatSent } from '../../src/sent/format.js';
import { buildReport } from '../../src/sent/report.js';
import { blockedBy } from '../../src/sent/where.js';

/**
 * That a call was stopped is read from its result. A result a remote party writes (an MCP
 * server's reply, a fetched page, a search) can say anything, the words of a stop included, and
 * the call it answers did run: the server got the key. So no stop is read from such a result,
 * and a call to another company recorded as stopped is never summed up as "nothing went
 * anywhere". All values are made up.
 */

const STOP = 'Stroq blocked this action (secret.egress): the key was not sent.';
const post = (tool: string, isError = true) => ({
  kind: 'post' as const,
  id: 't',
  tool,
  input: {},
  resultText: STOP,
  at: '',
  isError,
});

describe('a stop is not read from a result a remote party writes', () => {
  it.each(['mcp__evil__send', 'mcp__claude_ai_Drive__search', 'WebFetch', 'WebSearch'])(
    '%s',
    (tool) => {
      for (const agent of ['claude-code', 'codex', 'cursor'])
        expect(blockedBy(post(tool), agent)).toBeNull();
    },
  );

  it('still reads one from a shell command the hook stopped', () => {
    expect(blockedBy(post('Bash'), 'claude-code')).toBe('stroq');
  });
});

const stopped: Finding = {
  tier: 'blocked',
  name: 'STRIPE_SECRET_KEY',
  source: '/w/.env',
  provider: 'Stripe',
  rotate: 'https://dashboard.stripe.com/apikeys',
  place: {
    tier: 'blocked',
    route: 'command',
    tool: 'Bash',
    detail: 'curl',
    host: 'collect.example',
    blocked: 'stroq',
    wouldBe: 'third_party',
  },
  at: '2026-10-01T10:00:00Z',
  session: { agent: 'codex', id: 's', path: '/s.jsonl', cwd: '/w' },
  times: 1,
  sessions: 1,
  seen: 1,
};

const report = (findings: readonly Finding[]) =>
  buildReport({
    scope: 'machine',
    now: new Date('2026-10-19T00:00:00Z'),
    sessions: {
      total: 1,
      agents: { codex: { sessions: 1, oldest: null } },
      first: null,
      last: null,
    },
    keys: { compared: 3, files: [], env: 3, unreadable: 0 },
    findings,
    notChecked: [],
    unreadable: 0,
  });

describe('a call to another company recorded as stopped', () => {
  it('is never summed up with a check mark', () => {
    const text = formatSent(report([stopped]), '/home/u');
    expect(text).not.toContain('✓');
    expect(text.split('\n').slice(2, 4)).toEqual([
      '1 of your 3 keys appears in your agent sessions: 1 blocked before it ran.',
      '1 key was in a call to another company that the session records as stopped. Check below.',
    ]);
  });

  it('is counted on its own in --counts', () => {
    const counts = buildCounts(report([stopped]), '0.28.0');
    expect(counts.found.blocked).toBe(1);
    expect(counts.blocked_third_party).toBe(1);
  });

  it('a stop that would have stayed on this machine: the AI still saw the key', () => {
    const local = { ...stopped, place: { ...stopped.place, wouldBe: 'seen' as const } };
    const text = formatSent(report([local]), '/home/u');
    expect(text.split('\n')[2]).toBe(
      '1 of your 3 keys appears in your agent sessions: 1 blocked before it ran.',
    );
    expect(text).not.toContain('records as stopped');
    expect(text).toContain(
      "do       the call did not run, and your agent's model saw the key in it",
    );
    expect(buildCounts(report([local]), '0.28.0').blocked_third_party).toBe(0);
  });
});
