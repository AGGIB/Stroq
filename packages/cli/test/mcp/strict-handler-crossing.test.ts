import { describe, expect, it } from 'vitest';
import { handlerRig } from './strict-handler-rig.js';

/**
 * The message that crosses a cap is the one that ends the server, and it is audited like
 * the ones before it: the audit says which message was the last, not only that the server
 * was ended after the one before.
 */

const unknownId = (n: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 9000 + n, result: { content: [] } });
const logLine = (n: number): string =>
  JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: `n${n}` } });

describe('the message that crosses the hostile cap', () => {
  it('is audited, and then the end of the server is audited', async () => {
    const rig = handlerRig({ maxWithheld: 2 });
    for (let n = 1; n <= 3; n += 1) await rig.feed(unknownId(n));
    expect(rig.ruleIds()).toEqual([
      'mcp-strict-unknown-id',
      'mcp-strict-unknown-id',
      'mcp-strict-unknown-id',
      'mcp-strict-terminated',
    ]);
  });

  it('is audited when it is the one that answers a waiting request', async () => {
    const rig = handlerRig({ maxWithheld: 1 });
    rig.ledger.track({ id: 3, method: 'tools/call', toolName: 'mcp__srv__t' });
    await rig.feed(unknownId(1));
    await rig.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: 'not an object' }));
    expect(rig.ruleIds()).toEqual([
      'mcp-strict-unknown-id',
      'mcp-strict-invalid-shape',
      'mcp-strict-terminated',
    ]);
    expect(JSON.stringify(rig.sent)).toContain('"id":3');
  });
});

describe('the message that crosses the benign cap', () => {
  it('is audited too', async () => {
    const rig = handlerRig({ maxBenign: 3 });
    for (let n = 1; n <= 4; n += 1) await rig.feed(logLine(n));
    expect(rig.ruleIds().filter((id) => id === 'mcp-strict-unsolicited')).toHaveLength(4);
    expect(rig.ruleIds().at(-1)).toBe('mcp-strict-terminated');
  });
});

describe('after the server was ended', () => {
  it('nothing more is audited', async () => {
    const rig = handlerRig({ maxWithheld: 1 });
    for (let n = 1; n <= 6; n += 1) await rig.feed(unknownId(n));
    expect(rig.ruleIds()).toHaveLength(3);
  });
});
