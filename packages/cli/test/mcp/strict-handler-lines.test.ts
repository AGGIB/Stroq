import { describe, expect, it } from 'vitest';
import type { StroqEngine } from '@stroq/core';
import { handlerRig, track } from './strict-handler-rig.js';

/**
 * The handler against the lines a server can send, one at a time, with every dependency
 * injected: what is dropped without a word, what is read through a byte-order mark, which
 * ids are acceptable, and what happens when something inside it throws.
 */

const ok = (id: unknown = 3): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });

describe('a blank server line', () => {
  it.each([[''], ['   '], ['\t'], [' \t \r'], ['\r']])(
    'is dropped without a word: %j',
    async (blank) => {
      const rig = handlerRig({ maxWithheld: 1 });
      track(rig, 3);
      for (let i = 0; i < 5; i += 1) await rig.feed(blank);
      expect(rig.sent).toEqual([]);
      expect(rig.lines).toEqual([]);
      expect(rig.ruleIds()).toEqual([]);
      expect(rig.terminated()).toBe(0);
      // And the request it might have been the answer to is still waiting for its answer.
      await rig.feed(ok());
      expect(rig.lines).toHaveLength(1);
    },
  );

  it('is not a blank line when it is the unterminated end of a stream that has content', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(ok(), { eol: '' });
    expect(rig.lines).toHaveLength(1);
  });
});

describe('a byte-order mark before the JSON of a server line', () => {
  it('is skipped for parsing and delivered without it', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed(`﻿${ok()}`);
    expect(rig.sent).toEqual([]);
    expect(rig.lines).toHaveLength(1);
    expect(rig.lines[0]?.startsWith('{')).toBe(true);
  });

  it('does not turn a line that is not JSON into one', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed('﻿not json');
    // No reliable association: fail pending requests without forwarding the malformed text.
    expect(rig.ruleIds()).toEqual(['mcp-strict-unparsable']);
    expect(JSON.stringify(rig.sent)).toContain('(unparsable)');
    expect(rig.lines).toEqual([]);
  });

  it('is read through when the line is otherwise unparsable and names its id in its head', async () => {
    const rig = handlerRig();
    track(rig, 3);
    await rig.feed('﻿{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text"');
    expect(JSON.stringify(rig.sent)).toContain('"id":3');
    expect(JSON.stringify(rig.sent)).toContain('(unparsable)');
  });
});

describe('the id of a response', () => {
  it('has to be a string or a safe integer', async () => {
    for (const id of ['12345678901234567890', '9007199254740992', '1.5', '1e21']) {
      const rig = handlerRig();
      await rig.feed(
        `{"jsonrpc":"2.0","id":${id},"result":{"content":[{"type":"text","text":"ok"}]}}`,
      );
      expect(rig.lines).toEqual([]);
      expect(rig.ruleIds()).toEqual(['mcp-strict-invalid-shape']);
    }
  });

  it('is delivered when it is a safe integer, the largest included', async () => {
    const rig = handlerRig();
    track(rig, Number.MAX_SAFE_INTEGER);
    await rig.feed(ok(Number.MAX_SAFE_INTEGER));
    expect(rig.lines).toHaveLength(1);
    expect(rig.lines[0]).toContain(String(Number.MAX_SAFE_INTEGER));
  });

  it('is delivered when it is a string', async () => {
    const rig = handlerRig();
    track(rig, 'req-7');
    await rig.feed(ok('req-7'));
    expect(rig.lines).toHaveLength(1);
  });
});

describe('something throwing inside the handler', () => {
  it('still answers the request when the scan itself throws', async () => {
    const rig = handlerRig({
      scan: () => {
        throw new Error('boom');
      },
    });
    track(rig, 3);
    await rig.feed(ok());
    expect(JSON.stringify(rig.sent)).toContain('(scan-failed)');
    expect(JSON.stringify(rig.sent)).toContain('"id":3');
    expect(rig.lines).toEqual([]);
  });

  it('still answers the request when the engine throws', async () => {
    const engine = {
      post: async () => {
        throw new Error('audit append failed');
      },
    } as unknown as StroqEngine;
    const rig = handlerRig();
    const throwing = handlerRig({ ctx: { engine, sessionId: 's', server: 'srv', cwd: rig.home } });
    track(throwing, 3);
    await throwing.feed(ok());
    expect(JSON.stringify(throwing.sent)).toContain('(scan-failed)');
  });

  it('withholds a result the engine says it did not scan', async () => {
    const engine = {
      post: async () => ({
        scan: { verdict: 'clean', score: 0, matches: [] },
        taint: null,
        scanned: false,
        atoms: [],
        provenanceError: null,
      }),
    } as unknown as StroqEngine;
    const rig = handlerRig();
    const unscanned = handlerRig({ ctx: { engine, sessionId: 's', server: 'srv', cwd: rig.home } });
    track(unscanned, 3);
    await unscanned.feed(ok());
    expect(unscanned.lines).toEqual([]);
    expect(JSON.stringify(unscanned.sent)).toContain('(scan-failed)');
  });
});
