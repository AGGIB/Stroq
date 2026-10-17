import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAX_LINE_CHARS } from '../../src/mcp/framing.js';
import { STRICT_MAX_QUEUED_CHARS, STRICT_MAX_QUEUED_LINES } from '../../src/mcp/strict-limits.js';
import { createQueueGate } from '../../src/mcp/strict-queue.js';

describe('createQueueGate by line count', () => {
  it('pauses the source when the queue reaches its bound and resumes it at half', () => {
    const source = new PassThrough();
    const gate = createQueueGate(source, 4, Infinity);
    source.resume();
    for (let i = 0; i < 3; i += 1) gate.enter(10);
    expect(source.isPaused()).toBe(false);
    gate.enter(10);
    expect(source.isPaused()).toBe(true);
    gate.leave(10);
    gate.leave(10);
    expect(source.isPaused()).toBe(false);
  });

  it('pauses again on the next line when something else resumed the source', () => {
    const source = new PassThrough();
    const gate = createQueueGate(source, 2, Infinity);
    gate.enter(1);
    gate.enter(1);
    expect(source.isPaused()).toBe(true);
    source.resume();
    gate.enter(1);
    expect(source.isPaused()).toBe(true);
  });

  it('does not resume a source it did not pause', () => {
    const source = new PassThrough();
    const gate = createQueueGate(source, 10, Infinity);
    gate.enter(1);
    source.pause();
    gate.leave(1);
    expect(source.isPaused()).toBe(true);
  });
});

describe('createQueueGate by the text that is queued', () => {
  it('pauses on a few large lines, which the line count alone would let through', () => {
    const source = new PassThrough();
    source.resume();
    const gate = createQueueGate(source, 1000, 100);
    gate.enter(40);
    gate.enter(40);
    expect(source.isPaused()).toBe(false);
    gate.enter(40); // 120 characters queued, three lines of a thousand
    expect(source.isPaused()).toBe(true);
  });

  it('resumes only when both the lines and the text are down to half', () => {
    const source = new PassThrough();
    source.resume();
    const gate = createQueueGate(source, 1000, 100);
    gate.enter(60);
    gate.enter(60); // paused at 120
    expect(source.isPaused()).toBe(true);
    gate.leave(60); // 60 left: above half of 100
    expect(source.isPaused()).toBe(true);
    gate.enter(1);
    gate.leave(60); // 1 left
    expect(source.isPaused()).toBe(false);
  });

  it('counts an empty line as a line and as nothing else', () => {
    const source = new PassThrough();
    source.resume();
    const gate = createQueueGate(source, 3, 1000);
    gate.enter(0);
    gate.enter(0);
    expect(source.isPaused()).toBe(false);
    gate.enter(0);
    expect(source.isPaused()).toBe(true);
  });

  it('keeps its books through a leave for a line it never saw enter', () => {
    const source = new PassThrough();
    source.resume();
    const gate = createQueueGate(source, 3, 100);
    gate.leave(500);
    gate.enter(10);
    expect(source.isPaused()).toBe(false);
  });
});

describe('the bounds strict mode uses', () => {
  it('are tighter in text than the count would be in the worst case: 256 lines of 8 MiB is 2 GiB', () => {
    expect(STRICT_MAX_QUEUED_CHARS).toBe(32 * 1024 * 1024);
    expect(STRICT_MAX_QUEUED_CHARS).toBeLessThan(STRICT_MAX_QUEUED_LINES * MAX_LINE_CHARS);
  });
});
