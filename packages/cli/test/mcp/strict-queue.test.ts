import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createQueueGate } from '../../src/mcp/strict-queue.js';

describe('createQueueGate', () => {
  it('pauses the source when the queue reaches its bound and resumes it at half', () => {
    const source = new PassThrough();
    const gate = createQueueGate(source, 4);
    source.resume();
    for (let i = 0; i < 3; i += 1) gate.enter();
    expect(source.isPaused()).toBe(false);
    gate.enter();
    expect(source.isPaused()).toBe(true);
    gate.leave();
    gate.leave();
    expect(source.isPaused()).toBe(false);
  });

  it('pauses again on the next line when something else resumed the source', () => {
    const source = new PassThrough();
    const gate = createQueueGate(source, 2);
    gate.enter();
    gate.enter();
    expect(source.isPaused()).toBe(true);
    source.resume();
    gate.enter();
    expect(source.isPaused()).toBe(true);
  });

  it('does not resume a source it did not pause', () => {
    const source = new PassThrough();
    const gate = createQueueGate(source, 10);
    gate.enter();
    source.pause();
    gate.leave();
    expect(source.isPaused()).toBe(true);
  });
});
