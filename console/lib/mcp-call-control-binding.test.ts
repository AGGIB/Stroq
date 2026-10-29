import { describe, expect, it } from 'vitest';
import {
  callControlPreviewMatches,
  callControlReceiptMatches,
  callControlApplyInput,
  emptyCallControlAck,
} from './mcp-call-control-binding';
import { callInspection, callPreview, callReceipt } from './mcp-call-control-fixtures';
describe('exact MCP call-control client candidates', () => {
  it('permits a retained journal SHA only for retained Pause, keeping stable metadata and native binding exact', () => {
    const p = callPreview(),
      view = {
        ...callInspection(),
        artifact: { ...callInspection().artifact, sha256: '9'.repeat(64) },
      };
    expect(callControlPreviewMatches(p, view, 'pause')).toBe(false);
    expect(callControlPreviewMatches(p, view, 'pause', true)).toBe(true);
    for (const artifact of [
      { ...p.artifact, scope: 'user' as const },
      { ...p.artifact, agent: 'claude-code' as const },
      { ...p.artifact, name: 'Other' },
    ])
      expect(callControlPreviewMatches({ ...p, artifact }, view, 'pause', true)).toBe(false);
    expect(
      callControlPreviewMatches(
        { ...p, controlId: '00000000-0000-4000-8000-000000000099' },
        view,
        'pause',
        true,
      ),
    ).toBe(false);
  });
  it('rejects a completion belonging to another artifact or earlier than dispatch', () => {
    const p = callPreview(),
      r = callReceipt(p);
    expect(callControlReceiptMatches(r, p, p.createdAt)).toBe(true);
    expect(
      callControlReceiptMatches(
        { ...r, artifact: { ...r.artifact, scope: 'user', configSource: 'cursor-user' } },
        p,
        p.createdAt,
      ),
    ).toBe(false);
    expect(callControlReceiptMatches(r, p, '2026-10-24T10:00:02.000Z')).toBe(false);
  });
  it('requires only applicable consent but sends the exact finite acknowledged request', () => {
    const ack = { ...emptyCallControlAck(), scope: true };
    expect(callControlApplyInput(callPreview(), ack)).toEqual({
      previewId: callPreview().id,
      confirm: true,
      acknowledgeScope: true,
      acknowledgeWeakening: true,
      acknowledgeSharedScope: true,
      acknowledgeLocalStorage: true,
    });
    expect(callControlApplyInput(callPreview('resume'), ack)).toBeNull();
    expect(callControlApplyInput(callPreview('setup'), ack)).toBeNull();
    expect(callControlApplyInput({ ...callPreview(), sharedUserScope: true }, ack)).toBeNull();
  });
});
