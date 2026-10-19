import { describe, expect, it } from 'vitest';
import { handlerRig, track } from './strict-handler-rig.js';

describe('strict responses that cannot be associated reliably', () => {
  it.each([
    ['an id beyond the sniff window', `{"padding":"${'x'.repeat(1024)}","id":3,broken`],
    ['an unknown response id', '{"jsonrpc":"2.0","id":99,"result":{}}'],
    ['an invalid response id', '{"jsonrpc":"2.0","id":null,"result":{}}'],
    ['an unaddressable batch', '[{"jsonrpc":"2.0","id":99,"result":{}}]'],
    ['an empty batch', '[]'],
  ])('answers every pending request once for %s', async (_name, line) => {
    const rig = handlerRig();
    track(rig, 3);
    track(rig, 'four');
    await rig.feed(line);
    expect(rig.sent).toHaveLength(2);
    expect(rig.sent.map((value) => (value as { id: unknown }).id)).toEqual([3, 'four']);
    expect(rig.lines).toEqual([]);
    expect(rig.ledger.drain()).toEqual([]);
    expect(JSON.stringify(rig.sent)).not.toContain('padding');
    expect(JSON.stringify(rig.sent)).not.toContain('broken');
    await rig.feed(line);
    expect(rig.sent).toHaveLength(2);
  });

  it('does not let a late reply to a failed request fail a newer request', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed('{"jsonrpc":"2.0","id":99,"result":{}}');
    expect(rig.sent).toHaveLength(1);
    track(rig, 5);
    await rig.feed('{"jsonrpc":"2.0","id":3,"result":{}}');
    expect(rig.sent).toHaveLength(1);
    await rig.feed('{"jsonrpc":"2.0","id":5,"result":{}}');
    expect(rig.lines).toHaveLength(1);
    expect(rig.ledger.size).toBe(0);
  });
});
