import { describe, expect, it } from 'vitest';
import { createLineSplitter, MAX_LINE_CHARS } from '../../src/mcp/framing.js';
import { handlerRig, track } from './strict-handler-rig.js';

const batch = (padding = ''): string =>
  JSON.stringify([
    { jsonrpc: '2.0', id: 3, result: { padding } },
    { jsonrpc: '2.0', id: 'four', result: {} },
  ]);

describe('a batch whose complete set of response ids cannot be read', () => {
  for (const kind of ['malformed', 'oversize'] as const) {
    it.each([false, true])(
      `answers every pending request once for a ${kind} batch (first id completed: %s)`,
      async (firstCompleted) => {
        const rig = handlerRig();
        track(rig, 3);
        if (firstCompleted) rig.ledger.take(3);
        track(rig, 'four');
        if (kind === 'malformed') {
          await rig.feed(batch('server-only').slice(0, -1));
        } else {
          // A valid batch crosses the real framing bound before its later response id arrives.
          const line = batch('x'.repeat(MAX_LINE_CHARS));
          expect(line.length).toBeGreaterThan(MAX_LINE_CHARS);
          expect(() => JSON.parse(line)).not.toThrow();
          const splitter = createLineSplitter({ streamOversize: true });
          const head = splitter.push(line.slice(0, MAX_LINE_CHARS + 1));
          expect(head).toHaveLength(1);
          expect(head[0]).toMatchObject({ oversize: true, eol: '' });
          for (const segment of head) await rig.handler.onServerLine(segment);
          const tail = splitter.push(`${line.slice(MAX_LINE_CHARS + 1)}\n`);
          expect(tail).toHaveLength(1);
          expect(tail[0]).toMatchObject({ oversize: true, eol: '\n' });
          for (const segment of tail) await rig.handler.onServerLine(segment);
          expect(splitter.flush()).toEqual([]);
        }
        const ids = firstCompleted ? ['four'] : [3, 'four'];
        expect(rig.sent.map((value) => (value as { id: unknown }).id)).toEqual(ids);
        for (const response of rig.sent) {
          expect(response).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 } });
          expect(JSON.stringify(response)).toContain(
            kind === 'malformed' ? '(unparsable)' : '(oversize)',
          );
        }
        expect(rig.ledger.size).toBe(0);
        expect(rig.lines).toEqual([]);
        expect(rig.toServer).toEqual([]);
        expect(rig.ruleIds()).toEqual([
          `mcp-strict-${kind === 'malformed' ? 'unparsable' : 'oversize'}`,
        ]);
        expect(JSON.stringify([rig.sent, rig.audit()])).not.toContain('server-only');
        expect(rig.terminated()).toBe(0);

        // A late, readable reply for either failed id cannot answer it twice or fail a new request.
        track(rig, 5);
        await rig.feed(batch());
        expect(rig.sent).toHaveLength(ids.length);
        expect(rig.ledger.size).toBe(1);
        await rig.feed('{"jsonrpc":"2.0","id":5,"result":{}}');
        expect(rig.lines).toHaveLength(1);
        expect(rig.ledger.size).toBe(0);
      },
    );
  }

  it('keeps the remaining requests pending for a readable batch of known ids', async () => {
    const rig = handlerRig();
    track(rig, 3);
    track(rig, 'four');
    track(rig, 5);
    const duplicate = JSON.stringify([
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: 3, result: {} },
      { jsonrpc: '2.0', id: 'four', result: {} },
    ]);
    await rig.feed(duplicate);
    expect(rig.sent.map((value) => (value as { id: unknown }).id)).toEqual([3, 'four']);
    expect(rig.ledger.size).toBe(1);
    await rig.feed(batch());
    expect(rig.sent).toHaveLength(2);
    expect(rig.ledger.size).toBe(1);
    await rig.feed('{"jsonrpc":"2.0","id":5,"result":{}}');
    expect(rig.lines).toHaveLength(1);
    expect(rig.ledger.size).toBe(0);
  });
});
