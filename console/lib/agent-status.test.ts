import { describe, it, expect } from 'vitest';
import { validateAgentStatus, AGENT_NAMES } from './agent-status';
const state = {
  schema: 'stroq-agents/1',
  source: 'local',
  generatedAt: '2026-10-23T01:00:00.000Z',
  agents: Object.keys(AGENT_NAMES).map((id) => ({
    id,
    hostVersion: null,
    scopes: ['project', 'user'].map((scope) => ({
      scope,
      state: 'missing',
      reason: 'hooks-missing',
      events: [],
      approval: 'not-required',
      recordedAt: null,
    })),
    observation: { scope: 'machine', lastHookAt: null, state: 'missing' },
    proof: {
      scope: 'machine',
      state: 'missing',
      checkedAt: null,
      hostVersion: null,
      freshness: 'not-checked',
      reason: 'no-live-proof',
    },
  })),
};
describe('current installation evidence', () => {
  it('requires four known agents and both explicit scopes', () => {
    expect(validateAgentStatus(state)).toBe(true);
    expect(validateAgentStatus({ ...state, agents: state.agents.slice(1) })).toBe(false);
  });
  it('never accepts a machine stamp as verified project blocking', () => {
    expect(
      validateAgentStatus({
        ...state,
        agents: state.agents.map((a) => ({ ...a, proof: { ...a.proof, state: 'verified' } })),
      }),
    ).toBe(false);
  });
  it('rejects raw configuration and arbitrary command fields', () => {
    expect(
      validateAgentStatus({
        ...state,
        agents: state.agents.map((a) => ({ ...a, command: 'private-shell-command' })),
      }),
    ).toBe(false);
  });
});
