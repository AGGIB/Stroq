import { describe, expect, it } from 'vitest';
import {
  mcpContainmentHref,
  mcpContainmentReadAllowed,
  mcpContainmentSelection,
  resolveMcpContainmentSelection,
} from './mcp-containment-navigation';

const record = '12345678-abcd-4abc-8abc-123456789abc';
const workspace = 'workspace-' + 'a'.repeat(24);
const other = 'workspace-' + 'b'.repeat(24);
const read = (query: string) => mcpContainmentSelection(new URLSearchParams(query));

describe('MCP registration history links', () => {
  it('round-trips an exact record, workspace and attention filter', () => {
    const href = mcpContainmentHref(record, workspace, 'attention');
    expect(read(href.split('?')[1]!)).toEqual({
      recordId: record,
      workspaceId: workspace,
      requested: true,
      invalid: false,
      filter: 'attention',
    });
    expect(mcpContainmentHref(null, null, 'removed')).toBe('/skills/mcp/?view=removed');
    expect(mcpContainmentHref(null, null, 'configured')).toBe('/skills/mcp/?view=configured');
    expect(read('view=configured').filter).toBe('configured');
  });
  it('refuses incomplete, duplicate and malformed selections', () => {
    for (const query of [
      'record=',
      `record=${record}`,
      `workspace=${workspace}`,
      `record=${record}&record=${record}&workspace=${workspace}`,
      `record=${record}&workspace=${workspace}&workspace=${other}`,
      `record=${record}&workspace=${workspace}&view=all&view=attention`,
      `record=12345678-abcd-abcd-abcd-123456789abc&workspace=${workspace}`,
      `record=../private&workspace=${workspace}`,
    ])
      expect(read(query).invalid, query).toBe(true);
    expect(read('').requested).toBe(false);
  });
  it('does not read or show a record from another workspace', () => {
    const selection = read(`record=${record}&workspace=${workspace}`);
    const records = [{ id: record }, { id: '99999999-abcd-4abc-8abc-123456789abc' }];
    expect(mcpContainmentReadAllowed(selection, other)).toBe(false);
    expect(mcpContainmentReadAllowed(selection, null)).toBe(false);
    expect(mcpContainmentReadAllowed(selection, workspace)).toBe(true);
    expect(resolveMcpContainmentSelection(selection, other, records)).toEqual({
      status: 'workspace-mismatch',
      record: null,
    });
    expect(resolveMcpContainmentSelection(selection, null, records).status).toBe('context-pending');
    expect(resolveMcpContainmentSelection(selection, workspace, null).status).toBe('loading');
    expect(resolveMcpContainmentSelection(selection, workspace, records)).toEqual({
      status: 'selected',
      record: records[0],
    });
  });
  it('never replaces a missing selected record with another retained registration', () => {
    const selection = read(`record=${record}&workspace=${workspace}`);
    expect(resolveMcpContainmentSelection(selection, workspace, [{ id: 'other' }])).toEqual({
      status: 'missing',
      record: null,
    });
    expect(resolveMcpContainmentSelection(read(''), workspace, []).status).toBe('overview');
    expect(mcpContainmentReadAllowed(read('record='), workspace)).toBe(false);
  });
  it('canonicalizes away authentication, paths, search text and unknown filters', () => {
    const selected = read(
      `record=${record}&workspace=${workspace}&view=unknown&token=secret&q=/private`,
    );
    expect(mcpContainmentHref(selected.recordId, selected.workspaceId, selected.filter)).toBe(
      `/skills/mcp/?workspace=${workspace}&record=${record}`,
    );
    expect(mcpContainmentHref('../private?token=secret', workspace)).toBe('/skills/mcp/');
    expect(mcpContainmentHref(record, '/private/workspace')).toBe('/skills/mcp/');
  });
});
