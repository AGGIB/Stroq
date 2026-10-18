import { afterEach, describe, expect, it, vi } from 'vitest';
import { handlerRig, track } from './strict-handler-rig.js';

/**
 * The handler's decisions about WHICH request a message belongs to, and what it does when
 * it cannot write its own answer: the id of a response that has the wrong type, of one
 * for a request the client cancelled, of a line that could not be parsed, and the one
 * failure that cannot be reached with data, a message that will not serialise.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const result = (id: unknown): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });

describe('a response whose id has the wrong type', () => {
  it('is withheld, and the request it was evidently for is answered once', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(result('3'));
    expect(rig.lines).toEqual([]);
    expect(rig.sent).toHaveLength(1);
    expect(JSON.stringify(rig.sent)).toContain('"id":3');
    expect(JSON.stringify(rig.sent)).toContain('(id-mismatch)');
    expect(rig.ruleIds()).toEqual(['mcp-strict-id-mismatch']);
    // The right answer then arrives for a request that has been answered: unknown, counted.
    await rig.feed(result(3));
    expect(rig.lines).toEqual([]);
    expect(rig.ruleIds()).toEqual(['mcp-strict-id-mismatch', 'mcp-strict-unknown-id']);
  });

  it('is read the other way round too: a string id the client sent, answered with a number', async () => {
    const rig = handlerRig();
    track(rig, '7');
    await rig.feed(result(7));
    expect(JSON.stringify(rig.sent)).toContain('"id":"7"');
    expect(JSON.stringify(rig.sent)).toContain('(id-mismatch)');
  });

  it('is not taken for a mismatch when the digits only look alike', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(result('03'));
    expect(JSON.stringify(rig.sent)).toBe('[]');
    expect(rig.ruleIds()).toEqual(['mcp-strict-unknown-id']);
  });
});

describe('a request the client cancelled', () => {
  it('has its late answer dropped without a word, once', async () => {
    const rig = handlerRig({ maxWithheld: 1 });
    track(rig, 3);
    rig.ledger.cancel(3);
    await rig.feed(result(3));
    expect(rig.sent).toEqual([]);
    expect(rig.lines).toEqual([]);
    expect(rig.ruleIds()).toEqual([]);
    // A second answer for it is not excused.
    await rig.feed(result(3));
    expect(rig.ruleIds()).toEqual(['mcp-strict-unknown-id']);
  });

  it('does not excuse an answer of the other type: that is an unknown id, counted', async () => {
    const rig = handlerRig();
    track(rig, 3);
    rig.ledger.cancel(3);
    await rig.feed(result('3'));
    expect(rig.sent).toEqual([]);
    expect(rig.ruleIds()).toEqual(['mcp-strict-unknown-id']);
  });
});

describe('a line that could not be parsed', () => {
  it('answers the waiting request its head names, string ids included', async () => {
    const rig = handlerRig();
    track(rig, 'req-7');
    await rig.feed('{"jsonrpc":"2.0","id":"req-7","result":{"content":[{"type":"text","text":"');
    expect(JSON.stringify(rig.sent)).toContain('"id":"req-7"');
    expect(JSON.stringify(rig.sent)).toContain('(unparsable)');
  });

  it('answers nobody when the head names a request that is not waiting', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed('{"jsonrpc":"2.0","id":99,"result":{"content":[');
    expect(rig.sent).toEqual([]);
    expect(rig.ruleIds()).toEqual(['mcp-strict-unparsable']);
    // And the request that is waiting is still waiting, not answered on a guess.
    await rig.feed(result(3));
    expect(rig.lines).toHaveLength(1);
  });

  it('answers nobody when the id comes after the window, and says it was not answered', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(`{"result":"${'a'.repeat(600)}`);
    expect(rig.sent).toEqual([]);
    expect(JSON.stringify(rig.audit())).toContain('no request to answer');
  });

  it('answers the waiting request when an unparsable line is a batch', async () => {
    const rig = handlerRig();
    track(rig, 5);
    await rig.feed('[{"jsonrpc":"2.0","id":5,"result":{"content":[');
    expect(JSON.stringify(rig.sent)).toContain('"id":5');
    expect(JSON.stringify(rig.sent)).toContain('(unparsable)');
  });
});

describe('a batch sent by the server', () => {
  it('is withheld as invalid-shape and answers all waiting requests in the batch', async () => {
    const rig = handlerRig();
    track(rig, 3);
    track(rig, 4);
    await rig.feed(
      JSON.stringify([
        { jsonrpc: '2.0', id: 3, result: { content: [] } },
        { jsonrpc: '2.0', id: 4, result: { content: [] } },
      ]),
    );
    expect(rig.lines).toEqual([]);
    expect(rig.sent).toHaveLength(2);
    expect(JSON.stringify(rig.sent)).toContain('"id":3');
    expect(JSON.stringify(rig.sent)).toContain('"id":4');
    expect(JSON.stringify(rig.sent)).toContain('(invalid-shape)');
    expect(rig.ruleIds()).toEqual(['mcp-strict-invalid-shape']);
  });

  it('answers nobody when the batch names no waiting requests', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(JSON.stringify([{ jsonrpc: '2.0', id: 99, result: { content: [] } }]));
    expect(rig.lines).toEqual([]);
    expect(rig.sent).toEqual([]);
    expect(rig.ruleIds()).toEqual(['mcp-strict-invalid-shape']);
  });
});

describe('a message that will not serialise', () => {
  it('is withheld and its request answered, instead of being left waiting', async () => {
    const rig = handlerRig();
    track(rig, 3);
    // The line is built before the spy, which would fail this helper's own envelope too.
    const line = result(3);
    // Only the envelope of a delivery fails; everything else (the audit, the test runner's
    // own messages) serialises as it always did.
    const real = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, ...rest: unknown[]) => {
      if (typeof value === 'object' && value !== null && 'jsonrpc' in value && 'result' in value)
        throw new RangeError('Maximum call stack size exceeded');
      return (real as (...args: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify);
    await rig.feed(line);
    expect(rig.lines).toEqual([]);
    expect(JSON.stringify(rig.sent)).toContain('(scan-failed)');
    expect(JSON.stringify(rig.sent)).toContain('"id":3');
  });
});
