import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';
import { writeBackpressured } from '../../src/mcp/proxy-pump.js';

/**
 * Without pausing the SOURCE while a write to the destination is outstanding, a fast
 * writer paired with a slow reader grows the pending-write queue without bound: the
 * probe that found this (100k lines from a fast server against a slow-reading
 * client) measured this process's RSS past 380 MiB, with the server never slowed by
 * anything the proxy did. Covers both the low-level mechanism directly (injected
 * fake streams) and its wiring into the real `runMcpProxy` pipeline.
 */

/** A destination whose `write()` never completes until `release()` is called. */
function controllableSink(): { readonly sink: Writable; readonly release: () => void } {
  let pending: (() => void) | null = null;
  const sink = new Writable({
    highWaterMark: 0,
    write(_chunk, _encoding, callback) {
      pending = callback;
    },
  });
  return {
    sink,
    release: () => {
      const callback = pending;
      pending = null;
      callback?.();
    },
  };
}

describe('writeBackpressured', () => {
  it('pauses the source while the destination has not drained, and resumes once it does', async () => {
    const source = new PassThrough();
    const { sink, release } = controllableSink();

    expect(source.isPaused()).toBe(false);
    const writeDone = writeBackpressured(sink, 'hello', source);

    await vi.waitFor(() => expect(source.isPaused()).toBe(true), { timeout: 5000 });

    release();
    await writeDone;
    expect(source.isPaused()).toBe(false);
  });

  it('also resumes the source when the destination breaks instead of draining', async () => {
    const source = new PassThrough();
    const sink = new Writable({
      highWaterMark: 0,
      write() {
        // Never calls back: this destination hangs, then breaks.
      },
    });

    const writeDone = writeBackpressured(sink, 'hello', source);
    await vi.waitFor(() => expect(source.isPaused()).toBe(true), { timeout: 5000 });

    sink.destroy(new Error('destination broke'));
    // Resolves rather than rejects — a broken destination must not hang the queue
    // behind it, which `writeBackpressured` guarantees by never propagating this.
    await writeDone;
    expect(source.isPaused()).toBe(false);
  });

  it('does not pause at all when the destination accepts the write immediately', async () => {
    const source = new PassThrough();
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await writeBackpressured(sink, 'hello', source);
    expect(source.isPaused()).toBe(false);
  });
});

describe('backpressure through the real proxy pipeline', () => {
  const fakeServer = join(import.meta.dirname, 'fake-server.mjs');
  let cwd: string;

  beforeEach(() => {
    process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-mcp-backpressure-'));
    cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-backpressure-cwd-'));
  });

  it('pauses client stdin while a reply to it is backed up, and resumes once the reply drains', async () => {
    const stdin = new PassThrough();
    const { sink: stdout, release } = controllableSink();
    const stderr = new PassThrough();

    const done = runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      command: process.execPath,
      args: [fakeServer],
      stdin,
      stdout,
      stderr,
    });

    // A malformed tools/call (no tool name): judged and denied without the line
    // ever reaching the server, so the ONLY write it can trigger is the deny reply
    // written straight back to `stdout` — exactly the write this test backs up.
    expect(stdin.isPaused()).toBe(false);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })}\n`);

    await vi.waitFor(() => expect(stdin.isPaused()).toBe(true), { timeout: 5000 });

    release();
    await vi.waitFor(() => expect(stdin.isPaused()).toBe(false), { timeout: 5000 });

    stdin.end();
    expect(await done).toBe(0);
  }, 15_000);
});
