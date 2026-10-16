import type { StroqEngine } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { readStrictResult } from '../../src/mcp/strict-result.js';
import { handlerRig, track, type HandlerRig } from './strict-handler-rig.js';

/**
 * The handler scans every view of a result (see `strict-views.ts`): the bounded dry run
 * gets all of their texts at once, so they share one deadline, and the engine then scans
 * each, one after the other. The verdict is the worst of them, one warning is added however
 * many views were suspect, and a view that ran out of time withholds the result.
 */

const RESULT = { content: [{ type: 'text', text: 'hello' }] };
const line = (id: unknown = 3): string => JSON.stringify({ jsonrpc: '2.0', id, result: RESULT });

interface Posted {
  readonly text: string;
  readonly toolInput: unknown;
}

type Judge = (posted: Posted, index: number) => 'clean' | 'suspect' | 'timeout';

/** An engine that records what it is asked to scan and judges each text with `judge`. */
function recordingEngine(judge: Judge): { engine: StroqEngine; posted: Posted[] } {
  const posted: Posted[] = [];
  const engine = {
    post: async (event: { toolResultText: string; toolInput: unknown }) => {
      const entry = { text: event.toolResultText, toolInput: event.toolInput };
      const verdict = judge(entry, posted.length);
      posted.push(entry);
      const suspect = verdict !== 'clean';
      return {
        scan: {
          verdict: suspect ? 'suspect' : 'clean',
          score: suspect ? 9 : 0,
          matches: suspect ? [{ ruleId: `RULE-${posted.length}` }] : [],
          ...(verdict === 'timeout' ? { timedOut: true } : {}),
        },
        taint: null,
        scanned: true,
        atoms: [],
        provenanceError: null,
      };
    },
  } as unknown as StroqEngine;
  return { engine, posted };
}

function rigWith(
  judge: Judge,
  scan: (texts: readonly string[], toolName: string) => 'ok' | 'timeout' | 'failed' = () => 'ok',
): { rig: HandlerRig; posted: Posted[]; asked: (readonly string[])[] } {
  const base = handlerRig();
  const { engine, posted } = recordingEngine(judge);
  const asked: (readonly string[])[] = [];
  const rig = handlerRig({
    ctx: { engine, sessionId: 's', server: 'srv', cwd: base.home },
    scan: (texts, toolName) => {
      asked.push(texts);
      return scan(texts, toolName);
    },
  });
  return { rig, posted, asked };
}

const viewTexts = (): string[] => {
  const read = readStrictResult('tools/call', RESULT);
  if (!read.ok) throw new Error('unreadable');
  return read.views.map((view) => view.text);
};

const warningsIn = (lines: readonly string[]): number =>
  lines.join('').split('contains instruction-like text').length - 1;

describe('the views of a result in the handler', () => {
  it('are handed to the bounded scan together, as one job under one deadline', async () => {
    const { rig, asked } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(asked).toEqual([viewTexts()]);
    expect(asked[0]).toHaveLength(3);
  });

  it('are scanned by the engine one after the other, each text as it is', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(posted.map((entry) => entry.text)).toEqual(viewTexts());
    expect(rig.lines).toHaveLength(1);
  });

  it('name the method on every scan, and the view on every scan but the default one', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(posted.map((entry) => entry.toolInput)).toEqual([
      { method: 'tools/call' },
      { method: 'tools/call', view: 'strings' },
      { method: 'tools/call', view: 'json' },
    ]);
  });
});

describe('the verdict over the views', () => {
  it.each([[0], [1], [2]])(
    'is suspect when only view %i is, and the result carries one warning',
    async (which) => {
      const { rig } = rigWith((_posted, index) => (index === which ? 'suspect' : 'clean'));
      track(rig, 3);
      await rig.feed(line());
      expect(rig.lines).toHaveLength(1);
      expect(warningsIn(rig.lines)).toBe(1);
    },
  );

  it('is one warning, not three, when every view is suspect', async () => {
    const { rig, posted } = rigWith(() => 'suspect');
    track(rig, 3);
    await rig.feed(line());
    expect(posted).toHaveLength(3);
    expect(warningsIn(rig.lines)).toBe(1);
  });

  it('is clean when every view is', async () => {
    const { rig } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(warningsIn(rig.lines)).toBe(0);
  });

  it('withholds the result when any view ran out of time, and says so', async () => {
    const { rig } = rigWith((_posted, index) => (index === 1 ? 'timeout' : 'clean'));
    track(rig, 3);
    await rig.feed(line());
    expect(rig.lines).toEqual([]);
    expect(JSON.stringify(rig.sent)).toContain('(scan-timeout)');
  });

  it('does not ask the engine at all when the dry run did not finish', async () => {
    const { rig, posted } = rigWith(
      () => 'clean',
      () => 'timeout',
    );
    track(rig, 3);
    await rig.feed(line());
    expect(posted).toEqual([]);
    expect(rig.lines).toEqual([]);
    expect(JSON.stringify(rig.sent)).toContain('(scan-timeout)');
  });

  it('scans a result with nothing to read at all once, as a scanned method always is', async () => {
    const { rig, posted, asked } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }));
    expect(posted.map((entry) => entry.text)).toEqual(['']);
    expect(asked).toEqual([['']]);
    expect(rig.lines).toHaveLength(1);
  });

  it('does not scan a ping answer, which has nothing to read and is not a scanned method', async () => {
    const { rig, posted, asked } = rigWith(() => 'clean');
    track(rig, 3, 'ping');
    await rig.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }));
    expect(posted).toEqual([]);
    expect(asked).toEqual([]);
    expect(rig.lines).toHaveLength(1);
  });
});
