import { describe, expect, it } from 'vitest';
import {
  validateMcpCallControlApplyRequest,
  validateMcpCallControlPreviewRequest,
  validateMcpCallControlRecheckRequest,
  validateMcpCallControlSelection,
  validateMcpCallControlRecheck,
} from './mcp-call-controls';
const id = 'item-' + 'a'.repeat(24),
  sha = 'b'.repeat(64),
  context = 'context-' + 'c'.repeat(64),
  uuid = '00000000-0000-4000-8000-000000000001';
describe('closed MCP call control requests', () => {
  it('rejects contradictory absence and unavailable/current facts while preserving historical recorded decisions', () => {
    const base = {
      schema: 'stroq-mcp-call-control-recheck/1',
      checkedAt: '2026-10-26T10:00:00.000Z',
      workspaceId: 'workspace-' + 'a'.repeat(24),
      contextId: context,
      operationId: uuid,
      action: 'pause',
      controlId: uuid,
      invocationSha256: sha,
      authority: 'recorded',
      recordedEventId: uuid,
      configuration: 'unchanged',
      currentEventId: uuid,
      currentMode: 'paused',
      hostEnforcement: false,
    };
    expect(validateMcpCallControlRecheck(base)).toBe(true);
    expect(
      validateMcpCallControlRecheck({ ...base, authority: 'absent', recordedEventId: null }),
    ).toBe(false);
    expect(
      validateMcpCallControlRecheck({ ...base, authority: 'unavailable', recordedEventId: null }),
    ).toBe(false);
    expect(validateMcpCallControlRecheck({ ...base, configuration: 'confirmed' })).toBe(false);
    expect(validateMcpCallControlRecheck({ ...base, currentMode: 'enabled' })).toBe(false);
    expect(
      validateMcpCallControlRecheck({
        ...base,
        currentEventId: '00000000-0000-4000-8000-000000000002',
        currentMode: 'enabled',
      }),
    ).toBe(true);
  });
  it('accepts exact inventory selectors and rejects native selectors', () => {
    expect(validateMcpCallControlSelection({ id, expectedSha256: sha })).toBe(true);
    expect(validateMcpCallControlSelection({ id, expectedSha256: sha, path: '/tmp/private' })).toBe(
      false,
    );
  });
  it('binds preview and recheck to selected profile, exact revision and event', () => {
    const input = {
      id,
      expectedSha256: sha,
      expectedContextId: context,
      action: 'setup',
      expectedRevision: null,
      expectedEventId: null,
    };
    expect(validateMcpCallControlPreviewRequest(input)).toBe(true);
    expect(validateMcpCallControlPreviewRequest({ ...input, expectedContextId: undefined })).toBe(
      false,
    );
    expect(
      validateMcpCallControlRecheckRequest({
        id,
        expectedSha256: sha,
        expectedContextId: context,
        operationId: uuid,
        action: 'setup',
        controlId: uuid,
        invocationSha256: sha,
        expectedEventId: null,
      }),
    ).toBe(true);
  });
  it('requires explicit closed consent and never accepts implicit weakening', () => {
    const input = {
      previewId: uuid,
      confirm: true,
      acknowledgeScope: true,
      acknowledgeWeakening: true,
      acknowledgeSharedScope: true,
      acknowledgeLocalStorage: true,
    };
    expect(validateMcpCallControlApplyRequest(input)).toBe(true);
    expect(validateMcpCallControlApplyRequest({ ...input, acknowledgeWeakening: false })).toBe(
      false,
    );
    expect(validateMcpCallControlApplyRequest({ ...input, command: 'sh' })).toBe(false);
  });
});
