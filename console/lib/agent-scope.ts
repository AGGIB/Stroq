/** The scope the Agents page shows, from its address: `?scope=user` or the workspace by default. */
export type AgentScope = 'project' | 'user';

export function agentScope(params: Pick<URLSearchParams, 'get' | 'getAll'>): AgentScope {
  return params.getAll('scope').length === 1 && params.get('scope') === 'user' ? 'user' : 'project';
}

export function agentsHref(scope: AgentScope = 'project'): string {
  return scope === 'user' ? '/agents/?scope=user' : '/agents/';
}
