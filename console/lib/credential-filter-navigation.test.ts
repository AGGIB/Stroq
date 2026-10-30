import { describe, expect, it } from 'vitest';
import {
  credentialFilterHref,
  credentialFilterSelection,
  credentialFilterReadAllowed,
  resolveCredentialFilterSelection,
} from './credential-filter-navigation';
import {
  CREDENTIAL_FILTER_TARGETS,
  CREDENTIAL_FILTER_LIMITATIONS,
  type CredentialFiltersState,
} from './credential-filters';
const workspace = 'workspace-' + 'a'.repeat(24),
  other = 'workspace-' + 'b'.repeat(24);
const read = (query: string) => credentialFilterSelection(new URLSearchParams(query));
const state: CredentialFiltersState = {
  schema: 'stroq-credential-filters/1',
  source: 'local',
  workspaceId: workspace,
  generatedAt: '2026-10-23T12:00:00.000Z',
  available: true,
  reason: null,
  targets: Object.entries(CREDENTIAL_FILTER_TARGETS).map(([id, fixed]) => ({
    id: id as keyof typeof CREDENTIAL_FILTER_TARGETS,
    ...fixed,
    location: id === 'claude-user' ? 'user' : 'workspace',
    context: id === 'claude-user' ? 'all-workspaces' : 'workspace',
    status: 'absent',
    exists: false,
    sourceSha256: null,
    bytes: 0,
    present: 0,
    managed: 0,
    unmanaged: 0,
    applications: 0,
    undoAvailable: false,
    reason: null,
  })),
  limitations: [...CREDENTIAL_FILTER_LIMITATIONS],
};
describe('exact native filter navigation', () => {
  it('round-trips each fixed target, canonical workspace and derived scope/agent', () => {
    for (const target of Object.keys(
      CREDENTIAL_FILTER_TARGETS,
    ) as (keyof typeof CREDENTIAL_FILTER_TARGETS)[]) {
      const fixed = CREDENTIAL_FILTER_TARGETS[target];
      const href = credentialFilterHref(target, workspace);
      expect(href).toBe(`/agents/?workspace=${workspace}&filter=${target}#${fixed.agent}`);
      expect(read(href.split('?')[1]!.split('#')[0]!)).toEqual({
        requested: true,
        invalid: false,
        workspaceId: workspace,
        target,
        agent: fixed.agent,
        scope: fixed.scope,
      });
    }
  });
  it('keeps manual scope history as an overview without retaining any old target or workspace', () => {
    expect(credentialFilterHref(null, workspace, 'project')).toBe('/agents/');
    expect(credentialFilterHref(null, workspace, 'user')).toBe('/agents/?scope=user');
    expect(read('scope=user')).toEqual({
      requested: false,
      invalid: false,
      target: null,
      agent: null,
      workspaceId: null,
      scope: 'user',
    });
    expect(read('').scope).toBe('project');
    expect(read('scope=user').target).toBeNull();
    expect(read(`workspace=${workspace}&filter=claude-user`).scope).toBe('user');
    expect(read('scope=project').target).toBeNull();
  });
  it('rejects duplicate, unbound, malformed and scope-ambiguous exact selections', () => {
    for (const query of [
      'filter=',
      'filter=claude-user',
      `workspace=${workspace}`,
      `workspace=${workspace}&filter=cursor-user`,
      `workspace=${workspace}&filter=__proto__`,
      `workspace=${workspace}&filter=claude-user&scope=project`,
      `workspace=${workspace}&scope=user`,
      'scope=unknown',
      'scope=user&scope=user',
      `workspace=${workspace}&filter=claude-user&filter=claude-project`,
      `workspace=${workspace}&workspace=${other}&filter=claude-user`,
    ])
      expect(read(query).invalid, query).toBe(true);
  });
  it('blocks reads and selection until the exact workspace matches', () => {
    const selected = read(`workspace=${workspace}&filter=claude-user`);
    expect(credentialFilterReadAllowed(selected, null)).toBe(false);
    expect(credentialFilterReadAllowed(selected, other)).toBe(false);
    expect(credentialFilterReadAllowed(selected, workspace)).toBe(true);
    expect(credentialFilterReadAllowed(read('filter='), workspace)).toBe(false);
    expect(resolveCredentialFilterSelection(selected, null, state).status).toBe('context-pending');
    expect(resolveCredentialFilterSelection(selected, other, state).status).toBe(
      'workspace-mismatch',
    );
    expect(resolveCredentialFilterSelection(selected, workspace, null).status).toBe('loading');
    expect(
      resolveCredentialFilterSelection(selected, workspace, { ...state, workspaceId: other })
        .status,
    ).toBe('loading');
    expect(resolveCredentialFilterSelection(selected, workspace, state)).toEqual({
      status: 'selected',
      row: state.targets[1],
    });
  });
  it('never substitutes another target when selected evidence is missing', () => {
    const selected = read(`workspace=${workspace}&filter=claude-user`);
    expect(
      resolveCredentialFilterSelection(selected, workspace, {
        ...state,
        targets: [state.targets[0]!],
      }),
    ).toEqual({ status: 'missing', row: null });
    expect(resolveCredentialFilterSelection(read(''), workspace, state)).toEqual({
      status: 'overview',
      row: null,
    });
  });
  it('drops source paths, tokens, arbitrary query text and invalid identifiers from generated links', () => {
    const selected = read(
      `workspace=${workspace}&filter=claude-user&token=private&path=/Users/private`,
    );
    expect(credentialFilterHref(selected.target, selected.workspaceId)).toBe(
      `/agents/?workspace=${workspace}&filter=claude-user#claude-code`,
    );
    expect(credentialFilterHref('claude-user', '/Users/private')).toBe('/agents/');
    expect(credentialFilterHref('../private' as 'claude-user', workspace)).toBe('/agents/');
  });
});
