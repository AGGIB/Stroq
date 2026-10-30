import { it, expect } from 'vitest';
import {
  mcpGovernanceLocation as read,
  mcpGovernanceHref as href,
} from './mcp-governance-navigation';
import * as f from './mcp-governance-fixtures';
it('retains exact operation context and workspace after restart without source capture', () => {
  const url = href({
    contextId: f.governanceContext,
    operationId: f.governanceId(3),
    workspaceId: f.governanceWorkspace,
  });
  expect(read(new URL(url, 'http://local').searchParams)).toEqual({
    open: true,
    invalid: false,
    view: 'history',
    draft: null,
    contextId: f.governanceContext,
    operationId: f.governanceId(3),
    workspaceId: f.governanceWorkspace,
  });
});
it('rejects duplicates and incomplete authority, does not interpret foreign unrelated filters', () => {
  for (const q of [
    'mcpGovernance=history&mcpGovernance=capture',
    'mcpGovernance=history&governanceOperation=' + f.governanceId(3),
    'mcpGovernance=capture&governanceContext=/private/x',
  ])
    expect(read(new URLSearchParams(q)).invalid).toBe(true);
  expect(read(new URLSearchParams('kind=mcp&workspace=old')).open).toBe(false);
});
it('deny-all draft is an explicit capture-only deep link, never history or orphan query authority', () => {
  const url = href({ draft: 'deny-all' });
  expect(read(new URL(url, 'http://local').searchParams)).toMatchObject({
    open: true,
    invalid: false,
    view: 'capture',
    draft: 'deny-all',
  });
  for (const q of [
    'mcpGovernance=history&governanceDraft=deny-all',
    'mcpGovernance=capture&governanceDraft=allow-all',
    'mcpGovernance=capture&governanceDraft=deny-all&governanceDraft=deny-all',
    'governanceDraft=deny-all',
  ])
    expect(read(new URLSearchParams(q)).invalid).toBe(true);
});
