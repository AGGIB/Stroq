import type { StroqEngine } from '@stroq/core';
import { describe, expect, it } from 'vitest';
import { handlerRig, track } from './strict-handler-rig.js';

/**
 * Ending the server, and the messages that are in the handler's hands when it happens.
 * The pump hands the handler one server line at a time, so these interleavings do not
 * arise today; they are tested with lines fed at once because the guarantee does not
 * rest on the queue: whatever the handler has taken from the ledger it answers, once,
 * and an ended server is delivered nothing more.
 */

const hostile = (n: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id: `s${n}`, method: 'sampling/createMessage', params: {} });
const response = (id: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ok' }] } });

const answersFor = (sent: readonly unknown[], lines: readonly string[], id: number) =>
  [...sent, ...lines.map((text) => JSON.parse(text) as unknown)].filter(
    (message) => (message as { id?: unknown }).id === id,
  );

describe('ending the server', () => {
  it('sets the end and empties the ledger in one step: nothing can be tracked in between', async () => {
    const rig = handlerRig({ maxWithheld: 1 });
    track(rig, 3);
    track(rig, 4);
    await rig.feed(hostile(1));
    const crossing = rig.feed(hostile(2));
    // No await since the crossing message was fed: both have already happened.
    expect(rig.handler.wasTerminated()).toBe(true);
    expect(rig.ledger.size).toBe(0);
    expect(rig.terminated()).toBe(1);
    await crossing;
    expect(answersFor(rig.sent, rig.lines, 3)).toHaveLength(1);
    expect(answersFor(rig.sent, rig.lines, 4)).toHaveLength(1);
  });
});

describe('a response being scanned when the server is ended', () => {
  /** An engine whose scan of a result is held open until the test lets it go. */
  function slowEngine() {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = {
      post: async () => {
        await held;
        return {
          scan: { verdict: 'clean', score: 0, matches: [] },
          taint: null,
          scanned: true,
          atoms: [],
          provenanceError: null,
        };
      },
    } as unknown as StroqEngine;
    return { engine, release };
  }

  it('is answered once, as the end, and not delivered: never both, never neither', async () => {
    const { engine, release } = slowEngine();
    const base = handlerRig();
    const rig = handlerRig({
      maxWithheld: 1,
      ctx: { engine, sessionId: 's', server: 'srv', cwd: base.home },
    });
    track(rig, 3);
    const scanning = rig.feed(response(3));
    // The scan holds the response; two lines of the server's own end it meanwhile.
    await rig.feed(hostile(1));
    await rig.feed(hostile(2));
    expect(rig.handler.wasTerminated()).toBe(true);
    release();
    await scanning;
    const answers = answersFor(rig.sent, rig.lines, 3);
    expect(answers).toHaveLength(1);
    expect(JSON.stringify(answers[0])).toContain('ended this server');
    expect(rig.lines).toEqual([]);
  });

  it('is delivered, once, when the server is still there', async () => {
    const { engine, release } = slowEngine();
    const base = handlerRig();
    const rig = handlerRig({ ctx: { engine, sessionId: 's', server: 'srv', cwd: base.home } });
    track(rig, 3);
    const scanning = rig.feed(response(3));
    release();
    await scanning;
    expect(answersFor(rig.sent, rig.lines, 3)).toHaveLength(1);
    expect(rig.lines).toHaveLength(1);
  });
});

describe('a message being withheld when the server is ended', () => {
  it('has its request answered once, as the end, and writes the server nothing', async () => {
    const rig = handlerRig({ maxWithheld: 1 });
    track(rig, 3);
    // The first is a response with an unknown shape for request 3; it is still being
    // audited when the second one, a message of the server's own, ends the server.
    const first = rig.feed(
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [], smuggled: 'x' } }),
    );
    await rig.feed(hostile(1));
    await rig.feed(hostile(2));
    await first;
    expect(rig.handler.wasTerminated()).toBe(true);
    const answers = answersFor(rig.sent, rig.lines, 3);
    expect(answers).toHaveLength(1);
    expect(JSON.stringify(answers[0])).toContain('ended this server');
    expect(rig.lines).toEqual([]);
  });

  it('does not refuse a server request to a server that was ended meanwhile', async () => {
    const rig = handlerRig({ maxWithheld: 1 });
    const first = rig.feed(hostile(1));
    const second = rig.feed(hostile(2));
    await Promise.all([first, second]);
    expect(rig.handler.wasTerminated()).toBe(true);
    expect(rig.toServer).toEqual([]);
  });
});
