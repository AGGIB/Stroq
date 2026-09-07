import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * Every child `runMcpProxy` spawns for this file, so a failed assertion — which skips
 * the rest of a test, including the `await` that would have seen the child close —
 * cannot leave one running past the test that started it. `ignore-sigterm-server.mjs`
 * ignores both signals and, under `STROQ_MCP_STUB_KEEPALIVE`, no longer exits on
 * stdin EOF either, so an aborted run would otherwise orphan it for good.
 *
 * `runMcpProxy` calls `spawn` itself, so the handle is captured by wrapping the module
 * rather than by tracking a `spawn` this file made: the wrapper delegates to the real
 * implementation and only records what comes back.
 */
const { liveChildren } = vi.hoisted(() => ({ liveChildren: new Set<ChildProcess>() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      liveChildren.add(child);
      child.once('close', () => liveChildren.delete(child));
      return child;
    },
  };
});

afterEach(() => {
  for (const child of liveChildren) if (!child.killed) child.kill('SIGKILL');
  liveChildren.clear();
});

/**
 * Everything that makes `runMcpProxy` kill the server it wraps: the SIGINT/SIGTERM
 * relay and the timers that escalate a shutdown.
 *
 * The relay uses `process.on`, registered on THIS process — the same one
 * `runMcpProxy` runs in, exactly as it is when `stroq mcp` is a client's own
 * subprocess — which is why these tests deliver the signal to `process.pid` rather
 * than to a child: that IS what the proxy is listening for. `runMcpProxy`
 * deregisters both listeners before returning, so this is self-contained — no
 * listener from one test can affect the next.
 */

const fakeServer = join(import.meta.dirname, 'fake-server.mjs');
const ignoreSigtermServer = join(import.meta.dirname, 'ignore-sigterm-server.mjs');
const exitAfterReplyServer = join(import.meta.dirname, 'exit-after-reply-server.mjs');

let cwd: string;

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-mcp-signals-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-signals-cwd-'));
  // Off unless a test asks for it, so no test inherits the keep-alive from another.
  process.env['STROQ_MCP_STUB_KEEPALIVE'] = '0';
});

describe('signal escalation', () => {
  it('escalates to SIGKILL, within the injected grace period, when the server ignores a relayed SIGTERM', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const GRACE_MS = 200;

    const done = runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      command: process.execPath,
      args: [ignoreSigtermServer],
      stdin,
      stdout,
      stderr,
      shutdownGraceMs: GRACE_MS,
    });

    // Let the child actually spawn and register its own signal traps.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const start = Date.now();
    process.kill(process.pid, 'SIGTERM');

    const code = await done;
    const elapsed = Date.now() - start;

    // Killed by a signal: SIGTERM alone was ignored, so this is the escalation's
    // SIGKILL, and the exit-code contract ("a server killed by a signal exits the
    // proxy with 1") is unchanged either way.
    expect(code).toBe(1);
    // Waited roughly the INJECTED grace period before escalating...
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS - 30);
    // ...and nowhere near the default 2 s + 2 s, proving the injected value — not
    // SHUTDOWN_GRACE_MS — was what actually governed the wait.
    expect(elapsed).toBeLessThan(2000);
  }, 15_000);

  it('does not wait out the grace period when the server exits promptly on the relayed signal', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // Deliberately large: a proxy that wrongly waited out the grace even for a
    // well-behaved server would make this test obviously slow rather than subtly
    // wrong.
    const GRACE_MS = 3000;

    const done = runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      // fake-server.mjs registers no signal handler of its own, so Node's default
      // disposition for SIGTERM — terminate — applies the moment it is relayed.
      command: process.execPath,
      args: [fakeServer],
      stdin,
      stdout,
      stderr,
      shutdownGraceMs: GRACE_MS,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const start = Date.now();
    process.kill(process.pid, 'SIGTERM');
    const code = await done;
    const elapsed = Date.now() - start;

    expect(code).toBe(1);
    expect(elapsed).toBeLessThan(GRACE_MS / 2);
  }, 15_000);
});

describe('the EOF shutdown escalation', () => {
  it('ends the server stdin, then SIGTERMs, then SIGKILLs a server that outlives its client', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const GRACE_MS = 200;
    // The stub ignores both signals AND keeps its event loop alive past stdin EOF,
    // so it is exactly the server this path exists for: one that notices neither
    // its stdin closing nor the SIGTERM that follows. Without the keep-alive it
    // would exit on EOF by itself and the escalation would never be exercised.
    process.env['STROQ_MCP_STUB_KEEPALIVE'] = '1';

    const done = runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      command: process.execPath,
      args: [ignoreSigtermServer],
      stdin,
      stdout,
      stderr,
      shutdownGraceMs: GRACE_MS,
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const start = Date.now();
    // The client is gone: no signal is sent to the proxy at all, so everything that
    // follows is the EOF path's own escalation.
    stdin.end();

    const code = await done;
    const elapsed = Date.now() - start;

    // Killed by SIGKILL, which the proxy arms at twice the grace period.
    expect(code).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS * 2 - 30);
    expect(elapsed).toBeLessThan(5000);
  }, 15_000);
});

describe('the EOF shutdown timers', () => {
  /** Distinctive, so no unrelated timer in this worker can be mistaken for the proxy's. */
  const GRACE_MS = 271;

  it('are not armed by a client EOF that arrives once shutdown has already begun', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // Not inherited from whichever file ran before this one in the same worker.
    process.env['EXIT_AFTER_REPLY_EXIT_CODE'] = '0';

    const done = runMcpProxy({
      engine: createEngine(),
      sessionId: 'mcp:test',
      server: 'demo',
      cwd,
      // Answers one request and exits, so the run is over before the client is.
      command: process.execPath,
      args: [exitAfterReplyServer],
      stdin,
      stdout,
      stderr,
      shutdownGraceMs: GRACE_MS,
    });

    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    expect(await done).toBe(0);

    // The EOF handler runs inside a QUEUED task, so a client that closes its end
    // while the proxy is still draining can reach it after shutdown has cleared the
    // timers — and a kill armed from there is one nothing will ever cancel, holding
    // the event loop open for twice the grace period after the server it was meant
    // for is already gone. Emitted directly rather than via `stdin.end()` because
    // the natural version of this race is a matter of which queue drains first;
    // this pins the guard itself, deterministically.
    //
    // `setTimeout` is the assertion because an uncancellable timer aimed at a dead
    // child has no other observable effect than the delay it causes: the delays are
    // matched (not the call count) so an unrelated timer from anywhere else in the
    // worker cannot make this pass or fail by accident.
    const armed = vi.spyOn(globalThis, 'setTimeout');
    stdin.emit('end');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const delays = armed.mock.calls.map((call) => call[1]);
    armed.mockRestore();

    expect(delays).not.toContain(GRACE_MS);
    expect(delays).not.toContain(GRACE_MS * 2);
  }, 15_000);
});
