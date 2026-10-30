import { describe, expect, it } from 'vitest';
import { agentState, ago, protectionVerdict } from './agent-summary';
import type { AgentScopeStatus, AgentStatus, AgentStatusState } from './agent-status';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');

const scope = (over: Partial<AgentScopeStatus> = {}): AgentScopeStatus => ({
  scope: 'project',
  state: 'missing',
  reason: 'hooks-missing',
  events: [],
  approval: 'not-required',
  recordedAt: null,
  ...over,
});

const agent = (
  id: AgentStatus['id'],
  scopes: AgentScopeStatus[],
  lastHookAt: string | null = null,
): AgentStatus => ({
  id,
  hostVersion: null,
  scopes,
  observation: { scope: 'machine', lastHookAt, state: lastHookAt ? 'recorded' : 'missing' },
  proof: {
    scope: 'machine',
    state: 'not-attempted',
    checkedAt: null,
    hostVersion: null,
    freshness: 'not-checked',
    reason: 'x',
  },
});

const state = (agents: AgentStatus[]): AgentStatusState => ({
  schema: 'stroq-agents/1',
  source: 'local',
  generatedAt: '2026-10-27T12:00:00.000Z',
  agents,
});

const present = (over: Partial<AgentScopeStatus> = {}) =>
  scope({ state: 'present', reason: 'matches-current-install', ...over });

describe('one state per agent', () => {
  it('says not connected when no scope has the hooks', () => {
    const words = agentState(agent('cursor', [scope(), scope({ scope: 'user' })]), null, NOW);
    expect(words).toMatchObject({ kind: 'not-connected', label: 'Not connected', tone: 'muted' });
  });

  it('says needs attention for a broken, changed or disabled install, with the reason', () => {
    for (const s of [
      scope({ state: 'invalid', reason: 'config-invalid' }),
      scope({ state: 'changed', reason: 'hook-command-changed' }),
      present({ reason: 'hooks-disabled' }),
      present({ reason: 'approval-required' }),
    ]) {
      const words = agentState(agent('claude-code', [s]), null, NOW);
      expect(words.kind, s.reason).toBe('attention');
      // The line names the button the card shows: Review setup once hooks are present, else Configure.
      expect(words.line).toMatch(
        s.state === 'present' ? /Open Review setup to fix it/ : /Use Configure to fix it/,
      );
    }
  });

  it('separates hooks that are in place from hooks Stroq has actually been asked through', () => {
    expect(agentState(agent('codex', [present()]), null, NOW).kind).toBe('connected-unseen');
    const seen = agentState(agent('codex', [present()], '2026-10-27T11:50:00.000Z'), null, NOW);
    expect(seen).toMatchObject({ kind: 'connected-seen', label: 'Connected', tone: 'green' });
    expect(seen.line).toContain('10 min ago');
  });

  it('reads only the scope asked for when one is given', () => {
    const a = agent('claude-code', [present(), scope({ scope: 'user' })]);
    expect(agentState(a, 'project', NOW).kind).toBe('connected-unseen');
    expect(agentState(a, 'user', NOW).kind).toBe('not-connected');
  });

  it('says unknown when nothing could be read', () => {
    expect(
      agentState(
        agent('cursor', [scope({ state: 'unknown', reason: 'config-unreadable' })]),
        null,
        NOW,
      ).kind,
    ).toBe('unknown');
  });

  it('mentions an unverified hook approval', () => {
    expect(
      agentState(agent('claude-code', [present({ approval: 'unknown' })]), null, NOW).line,
    ).toContain('approval in the agent is unverified');
  });

  it('never says protected, safe or blocked', () => {
    for (const a of [
      agent('cursor', [scope()]),
      agent('cursor', [present()]),
      agent('cursor', [present()], '2026-10-27T11:00:00.000Z'),
      agent('cursor', [scope({ state: 'invalid', reason: 'config-invalid' })]),
    ])
      expect(JSON.stringify(agentState(a, null, NOW))).not.toMatch(
        /\b(protected|safe|secure|blocked)\b/i,
      );
  });
});

describe('the home screen answer', () => {
  it('leads with an attention problem over everything else', () => {
    const v = protectionVerdict(
      state([
        agent('claude-code', [present()], '2026-10-27T11:00:00.000Z'),
        agent('cursor', [present({ reason: 'hooks-disabled' })]),
      ]),
      NOW,
    );
    expect(v).toMatchObject({ tone: 'orange', title: 'Cursor needs attention' });
  });

  it('says first that nothing is asking Stroq when the only installed agent is broken', () => {
    const v = protectionVerdict(
      state([
        agent('claude-code', [present({ reason: 'hooks-disabled' })]),
        agent('cursor', [scope()]),
      ]),
      NOW,
    );
    expect(v).toMatchObject({ tone: 'orange', title: 'No agent is asking Stroq yet' });
    expect(v.detail).toBe(
      'Claude Code has hooks that will not work as they are; fix it first. Cursor is not connected.',
    );
  });

  it('says plainly when no agent is connected', () => {
    const v = protectionVerdict(
      state([agent('claude-code', [scope()]), agent('cursor', [scope()])]),
      NOW,
    );
    expect(v).toMatchObject({ tone: 'red', title: 'No agent is connected to Stroq' });
    expect(v.detail).toContain('nothing an agent does on this machine is judged');
  });

  it('separates connected from seen', () => {
    const v = protectionVerdict(
      state([agent('claude-code', [present()]), agent('cursor', [present()])]),
      NOW,
    );
    expect(v).toMatchObject({
      tone: 'orange',
      title: 'Claude Code and Cursor are connected, but not seen yet',
    });
  });

  it('names who Stroq is being asked by, and who is left out', () => {
    const v = protectionVerdict(
      state([
        agent('claude-code', [present()], '2026-10-27T11:59:30.000Z'),
        agent('cursor', [scope()]),
        agent('codex', [present()]),
      ]),
      NOW,
    );
    expect(v).toMatchObject({ tone: 'green', title: 'Stroq is being asked by Claude Code' });
    expect(v.detail).toBe('Codex CLI and Cursor are not being judged yet.');
    expect(v.agents).toHaveLength(3);
  });

  it('formats elapsed time in plain units', () => {
    expect(ago('2026-10-27T11:59:30.000Z', NOW)).toBe('just now');
    expect(ago('2026-10-27T09:00:00.000Z', NOW)).toBe('3 h ago');
    expect(ago('2026-10-20T12:00:00.000Z', NOW)).toBe('7 days ago');
  });
});
