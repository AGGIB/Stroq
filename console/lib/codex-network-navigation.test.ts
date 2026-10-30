import { describe, it, expect } from 'vitest';
import { codexNetworkHref, codexNetworkLocation } from './codex-network-navigation';
const context = 'codex-context-' + 'a'.repeat(64),
  workspace = 'workspace-' + 'b'.repeat(24),
  id = '00000000-0000-4000-8000-000000000001';
describe('Codex network navigation', () => {
  it('opens a quiet default entry without a capture request', () => {
    expect(codexNetworkHref()).toBe('/agents/?codexNetwork=default');
    expect(codexNetworkLocation(new URLSearchParams('codexNetwork=default')).open).toBe(true);
  });
  it('binds retained records to user context', () => {
    const q = new URL(codexNetworkHref({ recordId: id, controlContextId: context }), 'http://local')
      .searchParams;
    expect(codexNetworkLocation(q)).toMatchObject({
      invalid: false,
      view: 'history',
      recordId: id,
      controlContextId: context,
    });
  });
  it('namespaces check workspace to preserve existing filter navigation', () => {
    const href = codexNetworkHref({ jobId: id, controlContextId: context, workspaceId: workspace });
    expect(href).toContain('networkWorkspace=');
    expect(new URL(href, 'http://local').searchParams.has('workspace')).toBe(false);
    expect(codexNetworkLocation(new URL(href, 'http://local').searchParams)).toMatchObject({
      invalid: false,
      jobId: id,
      workspaceId: workspace,
    });
  });
  it.each([
    'codexNetwork=unknown',
    `codexNetwork=history&check=${id}`,
    `codexNetwork=default&record=${id}&context=${context}`,
    `codexNetwork=history&record=${id}&check=${id}&context=${context}&networkWorkspace=${workspace}`,
    `codexNetwork=history&check=${id}&context=${context}&networkWorkspace=${workspace}&networkWorkspace=${workspace}`,
  ])('rejects partial or ambiguous links: %s', (q) =>
    expect(codexNetworkLocation(new URLSearchParams(q)).invalid).toBe(true),
  );
  it('ignores ordinary credential filter links', () =>
    expect(
      codexNetworkLocation(new URLSearchParams('filter=claude-code-user&workspace=' + workspace)),
    ).toMatchObject({ open: false, invalid: false }));
});
