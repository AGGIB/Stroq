import { describe, expect, it, vi } from 'vitest';
import { call, line, list, result, rig } from './tool-approval-rig.js';

describe('tool approval at the real strict pump boundaries', () => {
  it('holds discovery and calls until exact approval, then requires explicit retries', async () => {
    const r = rig();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    expect(r.client.join('')).not.toContain('"description":"safe"');
    await r.clientLine(call(2));
    expect(r.server.join('')).not.toContain('tools/call');
    r.approve();
    await r.clientLine(list(3));
    await r.serverLine(result(3));
    await r.clientLine(call(4));
    expect(r.client.join('')).toContain('"description":"safe"');
    expect(r.server.join('')).toContain('"id":4');
    expect(r.server.join('')).not.toContain('"id":2');
  });

  it.each([{ nextCursor: 'page2' }, { nextCursor: '' }, { nextCursor: null }])(
    'never approves partial listings %j',
    async (extra) => {
      const r = rig();
      r.approve();
      await r.clientLine(list(1));
      await r.serverLine(result(1, extra));
      await r.clientLine(call(2));
      expect(r.store.observe).not.toHaveBeenCalled();
      expect(r.server.join('')).not.toContain('tools/call');
      expect(r.client.join('')).not.toContain('"description":"safe"');
    },
  );

  it('invalidates synchronously at list_changed ingress while policy is awaiting', async () => {
    const r = rig();
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    r.slow();
    const pending = r.clientLine(call(2));
    const changed = line({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    r.pump.onServerIngress?.(changed);
    r.judging.resolve();
    await pending;
    expect(r.server.join('')).not.toContain('tools/call');
    expect(r.ledger.size).toBe(0);
  });

  it('rechecks approval after policy and immediately before physical dispatch', async () => {
    const r = rig();
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    r.slow();
    const pending = r.clientLine(call(2));
    r.revoke();
    r.judging.resolve();
    await pending;
    expect(r.server.join('')).not.toContain('tools/call');
    expect(r.ledger.size).toBe(0);
  });

  it('rechecks launch-policy continuity inside the queued approval-store callback', async () => {
    let state: 'current' | 'changed' = 'current';
    const check = vi.fn(() => state);
    const r = rig({ policyCheck: check });
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    const delay = r.delay();
    const pending = r.clientLine(call(2));
    await vi.waitFor(() => expect(r.store.withApproved).toHaveBeenCalledTimes(2));
    state = 'changed';
    delay.resolve();
    await pending;
    expect(check).toHaveBeenCalledOnce();
    expect(r.server.join('')).not.toContain('tools/call');
    expect(r.ledger.size).toBe(0);
    expect(r.parsed().filter((message) => message.id === 2)).toHaveLength(1);
    expect(r.client.join('')).toContain('mcp-policy-changed');
    expect(r.client.join('')).not.toContain('mcp-tool-contract-not-approved');
  });

  it('does not let an old listed version regain authority during an asynchronous guard', async () => {
    const r = rig();
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    const delay = r.delay();
    const pending = r.clientLine(call(2));
    await vi.waitFor(() => expect(r.store.withApproved).toHaveBeenCalledTimes(2));
    r.pump.onServerIngress?.(line('not valid json'));
    delay.resolve();
    await pending;
    expect(r.server.join('')).not.toContain('tools/call');
  });

  it('rejects duplicate raw object keys and duplicate tool names without persisting a capture', async () => {
    for (const payload of [
      '{"jsonrpc":"2.0","id":1,"result":{"tools":[],"tools":[{"name":"lookup","inputSchema":{}}]}}',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            { name: 'lookup', inputSchema: {} },
            { name: 'lookup', inputSchema: {} },
          ],
        },
      }),
    ]) {
      const r = rig();
      r.approve();
      await r.clientLine(list(1));
      await r.serverLine(payload);
      await r.clientLine(call(2));
      expect(r.store.observe).not.toHaveBeenCalled();
      expect(r.server.join('')).not.toContain('tools/call');
    }
  });
  it('keeps normal policy and complete content scanning as independent gates', async () => {
    const denied = rig({ deny: true });
    denied.approve();
    await denied.clientLine(list(1));
    await denied.serverLine(result(1));
    await denied.clientLine(call(2));
    expect(denied.server.join('')).not.toContain('tools/call');
    expect(denied.store.withApproved).toHaveBeenCalledTimes(1);
    const unread = rig({ scan: 'timeout' });
    unread.approve();
    await unread.clientLine(list(1));
    await unread.serverLine(result(1));
    expect(unread.store.observe).not.toHaveBeenCalled();
    expect(unread.client.join('')).not.toContain('"description":"safe"');
  });

  it('starts every new connection without current-discovery authority', async () => {
    const r = rig();
    r.approve();
    await r.clientLine(call(1));
    expect(r.server).toEqual([]);
    expect(r.store.withApproved).not.toHaveBeenCalled();
  });

  it('does not answer a dispatched request twice when shutdown overlaps lock release', async () => {
    const r = rig({ maxWithheld: 1 });
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    const release = r.afterSend();
    const pending = r.clientLine(call(2));
    await vi.waitFor(() => expect(r.server.join('')).toContain('"id":2'));
    for (const id of ['s1', 's2'])
      await r.serverLine({ jsonrpc: '2.0', id, method: 'sampling/createMessage', params: {} });
    release.resolve();
    await pending;
    expect(r.parsed().filter((message) => message.id === 2)).toHaveLength(1);
  });

  it('invalidates malformed response shapes at ingress before the server queue can await', async () => {
    const r = rig();
    r.approve();
    await r.clientLine(list(1));
    await r.serverLine(result(1));
    await r.clientLine({ jsonrpc: '2.0', id: 3, method: 'ping' });
    r.slow();
    const pending = r.clientLine(call(2));
    r.pump.onServerIngress?.(line({ jsonrpc: '2.0', id: 3, error: 'not an error object' }));
    r.judging.resolve();
    await pending;
    expect(r.server.join('')).not.toContain('tools/call');
  });
});
