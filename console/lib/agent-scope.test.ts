import { describe, expect, it } from 'vitest';
import { agentScope, agentsHref } from './agent-scope';

const read = (query: string) => agentScope(new URLSearchParams(query));

describe('the Agents page scope', () => {
  it('is the workspace unless the address asks for the user scope exactly once', () => {
    expect(read('')).toBe('project');
    expect(read('scope=project')).toBe('project');
    expect(read('scope=user')).toBe('user');
    expect(read('scope=user&scope=user')).toBe('project');
    expect(read('scope=USER')).toBe('project');
    expect(read('scope=__proto__')).toBe('project');
  });

  it('ignores the filter links of earlier versions instead of selecting anything', () => {
    expect(read('workspace=workspace-aaaaaaaaaaaaaaaaaaaaaaaa&filter=claude-user')).toBe('project');
  });

  it('writes a clean address for the default scope and round-trips the user scope', () => {
    expect(agentsHref()).toBe('/agents/');
    expect(agentsHref('project')).toBe('/agents/');
    expect(agentsHref('user')).toBe('/agents/?scope=user');
    expect(read(agentsHref('user').split('?')[1] ?? '')).toBe('user');
  });
});
