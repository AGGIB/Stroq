import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  callControlDigest,
  encodeCallControlState,
  parseCallControlState,
} from '../../src/mcp/call-control-state.js';
import type { McpCallControlEvent } from '../../src/mcp/call-control-types.js';

const sha = 'a'.repeat(64);
const at = '2026-10-26T12:00:00.000Z';
function history(count: number): McpCallControlEvent[] {
  const controlId = randomUUID();
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
    controlId,
    previousEventId:
      i === 0 ? null : `00000000-0000-4000-8000-${(i - 1).toString(16).padStart(12, '0')}`,
    invocationSha256: sha,
    at,
    action: i === 0 ? 'configure-paused' : i % 2 ? 'resume' : 'pause',
  }));
}
function repairChecksum(value: Record<string, unknown>): Buffer {
  const { sha256: _, ...body } = value;
  return Buffer.from(JSON.stringify({ ...body, sha256: callControlDigest(JSON.stringify(body)) }));
}

describe('bounded canonical MCP call-control history', () => {
  it('accepts exact 512 events and refuses the next without eviction', () => {
    expect(
      parseCallControlState(encodeCallControlState(history(512), sha), sha).events,
    ).toHaveLength(512);
    expect(() => encodeCallControlState(history(513), sha)).toThrow('mcp-call-control-limit');
  });
  it('accepts 64 controls and refuses the next', () => {
    const events = Array.from({ length: 65 }, () => ({ ...history(1)[0]!, id: randomUUID() }));
    expect(
      parseCallControlState(encodeCallControlState(events.slice(0, 64), sha), sha).controls,
    ).toHaveLength(64);
    expect(() => encodeCallControlState(events, sha)).toThrow('mcp-call-control-limit');
  });
  it('refuses malformed chains, duplicate IDs, invalid dates, drift and silent rebinds', () => {
    const events = history(3);
    for (const changed of [
      { ...events[1]!, previousEventId: null },
      { ...events[1]!, id: events[0]!.id },
      { ...events[1]!, at: '2026-02-30T12:00:00.000Z' },
      { ...events[1]!, at: '2025-10-26T12:00:00.000Z' },
      { ...events[1]!, invocationSha256: 'b'.repeat(64) },
      { ...events[1]!, action: 'rebind-paused' as const },
    ])
      expect(() => encodeCallControlState([events[0]!, changed], sha)).toThrow(
        'mcp-call-control-invalid',
      );
  });
  it('refuses altered checksums and persisted current-state contradictions', () => {
    const bytes = encodeCallControlState(history(1), sha);
    const value = JSON.parse(bytes.toString()) as Record<string, unknown>;
    expect(() =>
      parseCallControlState(Buffer.from(bytes.toString().replace(sha, 'b'.repeat(64))), sha),
    ).toThrow();
    expect(() => parseCallControlState(repairChecksum({ ...value, controls: [] }), sha)).toThrow(
      'mcp-call-control-invalid',
    );
    expect(() => parseCallControlState(Buffer.from('{"x":1,"x":2}'), sha)).toThrow(
      'mcp-call-control-invalid',
    );
    expect(() =>
      parseCallControlState(Buffer.from(JSON.stringify({ huge: Array(16_384).fill(null) })), sha),
    ).toThrow('mcp-call-control-limit');
    expect(() => parseCallControlState(Buffer.from([0xff]), sha)).toThrow(
      'mcp-call-control-invalid',
    );
    expect(() => parseCallControlState(Buffer.alloc(384 * 1024 + 1), sha)).toThrow(
      'mcp-call-control-limit',
    );
  });
});
