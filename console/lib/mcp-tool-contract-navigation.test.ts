import { describe, expect, it } from 'vitest';
import {
  mcpToolContractHref,
  mcpToolContractSelection,
  mcpToolContractReadAllowed,
} from './mcp-tool-contract-navigation';
const workspaceId = `workspace-${'a'.repeat(24)}`,
  registrationId = `item-${'b'.repeat(24)}`,
  bindingId = `binding-${'c'.repeat(64)}`,
  toolId = `tool-${'d'.repeat(64)}`,
  contractSha256 = 'e'.repeat(64);
describe('exact MCP tool contract navigation', () => {
  it('keeps the overview read-only and leaves no selected registration', () => {
    const selected = mcpToolContractSelection(new URLSearchParams());
    expect(selected.requested).toBe(false);
    expect(selected.registrationId).toBeNull();
    expect(mcpToolContractReadAllowed(selected, workspaceId)).toBe(true);
  });
  it('round trips exact registration binding and tool version without raw metadata', () => {
    const href = mcpToolContractHref({
      workspaceId,
      registrationId,
      bindingId,
      toolId,
      contractSha256,
    });
    const selected = mcpToolContractSelection(new URL(href, 'http://local.test').searchParams);
    expect(selected).toEqual({
      requested: true,
      invalid: false,
      workspaceId,
      registrationId,
      bindingId,
      toolId,
      contractSha256,
    });
    expect(mcpToolContractReadAllowed(selected, workspaceId)).toBe(true);
    expect(mcpToolContractReadAllowed(selected, `workspace-${'f'.repeat(24)}`)).toBe(false);
  });
  it('rejects partial, duplicate and raw-name selectors without choosing another entry', () => {
    const base = `workspace=${workspaceId}&registration=${registrationId}&binding=${bindingId}`;
    for (const query of [
      `registration=${registrationId}`,
      `workspace=${workspaceId}`,
      `${base}&tool=${toolId}`,
      `${base}&version=${contractSha256}`,
      `${base}&binding=${bindingId}`,
      `${base}&tool=${toolId}&tool=${toolId}&version=${contractSha256}`,
      `${base}&tool=${toolId}&version=${contractSha256}&version=${contractSha256}`,
      `${base}&registration=raw:server`,
      `${base}&tool=raw:tool&version=${contractSha256}`,
    ]) {
      const selected = mcpToolContractSelection(new URLSearchParams(query));
      expect(selected.invalid, query).toBe(true);
      expect(selected.registrationId).toBeNull();
      expect(mcpToolContractReadAllowed(selected, workspaceId)).toBe(false);
    }
  });
  it('permits registration-only review but never invents a missing tool version', () => {
    const href = mcpToolContractHref({ workspaceId, registrationId, bindingId });
    expect(
      mcpToolContractSelection(new URL(href, 'http://local.test').searchParams).toolId,
    ).toBeNull();
    expect(mcpToolContractHref({ workspaceId, registrationId, bindingId, toolId })).toBe(
      '/skills/mcp/contracts/',
    );
  });
});
