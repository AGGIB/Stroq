import { describe, it, expect } from 'vitest';
import { skillSourceOf, validateSkillSourceCoverage } from './skill-sources';
describe('fixed skill sources', () => {
  it('preserves only known legacy Claude origin and binds new origins to their owner', () => {
    expect(skillSourceOf({ kind: 'skill', agent: 'claude-code' })).toBe('claude-skills');
    expect(skillSourceOf({ kind: 'skill', agent: 'shared', skillSource: 'agents-skills' })).toBe(
      'agents-skills',
    );
    expect(skillSourceOf({ kind: 'skill', agent: 'codex' })).toBe(null);
    expect(
      skillSourceOf({ kind: 'skill', agent: 'claude-code', skillSource: 'agents-skills' }),
    ).toBe(null);
    expect(skillSourceOf({ kind: 'mcp', agent: 'claude-code' })).toBe(null);
  });
  it('allows bounded measured root coverage without inventing active host state', () => {
    expect(
      validateSkillSourceCoverage({
        id: 'agents-skills',
        scope: 'user',
        status: 'complete',
        candidates: 153,
      }),
    ).toBe(true);
    for (const v of [
      { id: 'agents-skills', scope: 'user', status: 'loaded', candidates: 1 },
      { id: 'agents-skills', scope: 'user', status: 'absent', candidates: 1 },
      { id: 'agents-skills', scope: 'system', status: 'complete', candidates: 0 },
      { id: 'agents-skills', scope: 'user', status: 'complete', candidates: 257 },
      { id: 'agents-skills', scope: 'user', status: 'complete', candidates: 1, path: '/private' },
    ])
      expect(validateSkillSourceCoverage(v)).toBe(false);
  });
});
