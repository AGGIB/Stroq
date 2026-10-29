import { describe, expect, it } from 'vitest';
import { mcpCallControlLocation, mcpCallControlSelected } from './mcp-call-control-navigation';
import { callContext, callUuid } from './mcp-call-control-fixtures';
describe('exact call control recovery links', () => {
  it('accepts paired opaque control and profile selectors', () => {
    const s = mcpCallControlLocation(
      new URLSearchParams({ control: callUuid(1), context: callContext }),
    );
    expect(s).toEqual({
      requested: true,
      invalid: false,
      controlId: callUuid(1),
      contextId: callContext,
    });
    expect(
      mcpCallControlSelected(s, { contextId: callContext, controls: [{ controlId: callUuid(1) }] }),
    ).toBe('selected');
  });
  it('never falls back for missing, duplicate, malformed or foreign selectors', () => {
    for (const query of [
      `control=${callUuid(1)}`,
      `context=${callContext}`,
      `control=${callUuid(1)}&context=${callContext}&control=${callUuid(1)}`,
      `control=private&context=${callContext}`,
    ])
      expect(mcpCallControlLocation(new URLSearchParams(query)).invalid).toBe(true);
    const s = mcpCallControlLocation(
      new URLSearchParams({ control: callUuid(1), context: callContext }),
    );
    expect(
      mcpCallControlSelected(s, {
        contextId: 'context-' + '1'.repeat(64),
        controls: [{ controlId: callUuid(1) }],
      }),
    ).toBe('different-profile');
    expect(
      mcpCallControlSelected(s, { contextId: callContext, controls: [{ controlId: callUuid(2) }] }),
    ).toBe('missing');
  });
});
