import { describe, expect, it } from 'vitest';
import { quarantineHref, quarantineSelection } from './quarantine-navigation';
const recordId = '12345678-abcd-abcd-abcd-123456789abc',
  workspaceId = 'workspace-' + 'a'.repeat(24);
describe('quarantine history links are local and workspace-bound', () => {
  it('retains a selected record and filter through reload', () => {
    const href = quarantineHref(recordId, workspaceId, 'attention');
    expect(quarantineSelection(new URL(href, 'http://localhost').searchParams)).toEqual({
      recordId,
      workspaceId,
      invalid: false,
      filter: 'attention',
    });
  });
  it('does not silently bind a record to a different current workspace', () => {
    expect(quarantineSelection(new URLSearchParams('record=' + recordId)).invalid).toBe(true);
    expect(quarantineHref(recordId, '/private/project')).toBe('/skills/quarantine/');
  });
  it('refuses traversal, source paths and credential-like identifiers', () => {
    for (const record of ['/private/secret', '../skill', 'token=private', ''])
      expect(
        quarantineSelection(new URLSearchParams({ record, workspace: workspaceId })).invalid,
      ).toBe(true);
  });
  it('canonicalizes away raw queries, auth and fragments', () => {
    const selected = quarantineSelection(
      new URLSearchParams({
        record: recordId,
        workspace: workspaceId,
        view: 'unknown',
        token: 'secret',
        q: '/private/path',
      }),
    );
    expect(quarantineHref(selected.recordId, selected.workspaceId, selected.filter)).toBe(
      '/skills/quarantine/?workspace=' + workspaceId + '&record=' + recordId,
    );
  });
});
