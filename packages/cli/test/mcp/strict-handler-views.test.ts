import type { StroqEngine } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { readStrictResult } from '../../src/mcp/strict-result.js';
import { handlerRig, track, type HandlerRig } from './strict-handler-rig.js';

/**
 * The handler scans every view of a result (see `strict-views.ts`): the bounded dry run
 * gets all of their texts at once, so they share one deadline, and the engine then scans
 * each, one after the other: the extra views first, as extra readings (they scan and taint,
 * remember nothing and are audited only when they match), and the first view last, as the
 * call that records the result, flagged when an extra reading of it was suspect. The verdict
 * is the worst of them, one warning is added however many views were suspect, and a view
 * that ran out of time withholds the result.
 */

const RESULT = { content: [{ type: 'text', text: 'hello' }] };
const line = (id: unknown = 3): string => JSON.stringify({ jsonrpc: '2.0', id, result: RESULT });

interface Posted {
  readonly text: string;
  readonly toolInput: unknown;
  readonly extraReading: boolean;
  readonly suspectInAnotherReading: boolean;
  readonly otherReadings: readonly string[] | undefined;
}

type Judge = (posted: Posted, index: number) => 'clean' | 'suspect' | 'timeout';

/** An engine that records what it is asked to scan and judges each text with `judge`. */
function recordingEngine(judge: Judge): { engine: StroqEngine; posted: Posted[] } {
  const posted: Posted[] = [];
  const engine = {
    post: async (event: {
      toolResultText: string;
      toolInput: unknown;
      extraReading?: true;
      suspectInAnotherReading?: true;
      otherReadings?: readonly string[];
    }) => {
      const entry = {
        text: event.toolResultText,
        toolInput: event.toolInput,
        extraReading: event.extraReading === true,
        suspectInAnotherReading: event.suspectInAnotherReading === true,
        otherReadings: event.otherReadings,
      };
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

  it('are scanned by the engine one after the other, each text as it is: the extra views first, the first view last', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    const [first, ...extras] = viewTexts();
    expect(posted.map((entry) => entry.text)).toEqual([...extras, first]);
    expect(rig.lines).toHaveLength(1);
  });

  it('name the method on every scan, and the view on every scan but the default one', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(posted.map((entry) => entry.toolInput)).toEqual([
      { method: 'tools/call', view: 'strings' },
      { method: 'tools/call', view: 'json' },
      { method: 'tools/call' },
    ]);
  });

  it('make every view but the first an extra reading, and the first the one that records', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(posted.map((entry) => entry.extraReading)).toEqual([true, true, false]);
    expect(posted.map((entry) => entry.suspectInAnotherReading)).toEqual([false, false, false]);
  });
});

describe('the call that records the result, and what only another view held', () => {
  it('is handed the texts of the other views, so the atoms only they hold are remembered too', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    const [first, ...extras] = viewTexts();
    const recording = posted.at(-1);
    expect(recording?.text).toBe(first);
    expect(recording?.otherReadings).toEqual(extras);
    expect(extras.length).toBe(2);
  });

  it('is the only call that is handed them: an extra reading remembers nothing', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    await rig.feed(line());
    expect(posted.slice(0, -1).map((entry) => entry.otherReadings)).toEqual([undefined, undefined]);
  });

  it('is handed nothing when the result has only one view', async () => {
    const { rig, posted } = rigWith(() => 'clean');
    track(rig, 3);
    // An empty-ish result: a ping-like answer for a scanned method has one empty default view.
    await rig.feed(JSON.stringify({ jsonrpc: '2.0', id: 3, result: {} }));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.otherReadings).toBeUndefined();
  });
});

describe('the call that records the result', () => {
  it.each([[0], [1]])(
    'is told when extra reading %i was suspect, so what it remembers is flagged',
    async (which) => {
      const { rig, posted } = rigWith((_posted, index) => (index === which ? 'suspect' : 'clean'));
      track(rig, 3);
      await rig.feed(line());
      expect(posted.map((entry) => entry.suspectInAnotherReading)).toEqual([false, false, true]);
    },
  );

  it('is not told when only it was suspect: its own verdict is what flags', async () => {
    const { rig, posted } = rigWith((_posted, index) => (index === 2 ? 'suspect' : 'clean'));
    track(rig, 3);
    await rig.feed(line());
    expect(posted.map((entry) => entry.suspectInAnotherReading)).toEqual([false, false, false]);
    expect(warningsIn(rig.lines)).toBe(1);
  });

  it('is not run at all when an extra reading ran out of time: the result is withheld unrecorded', async () => {
    const { rig, posted } = rigWith((_posted, index) => (index === 1 ? 'timeout' : 'clean'));
    track(rig, 3);
    await rig.feed(line());
    expect(posted).toHaveLength(2);
    expect(posted.every((entry) => entry.extraReading)).toBe(true);
    expect(rig.lines).toEqual([]);
    expect(JSON.stringify(rig.sent)).toContain('(scan-timeout)');
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
