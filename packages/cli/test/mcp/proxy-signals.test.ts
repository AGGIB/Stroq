import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * `runMcpProxy` relays a SIGINT/SIGTERM it receives to the server (`process.on`,
 * registered on THIS process — the same one `runMcpProxy` runs in, exactly as it is
 * when `stroq mcp` is a client's own subprocess), which is why these tests deliver
 * the signal to `process.pid` rather than to a child: that IS what the proxy is
 * listening for. `runMcpProxy` deregisters both listeners before returning, so this
 * is self-contained — no listener from one test can affect the next.
 */

const fakeServer = join(import.meta.dirname, 'fake-server.mjs');
const ignoreSigtermServer = join(import.meta.dirname, 'ignore-sigterm-server.mjs');

let cwd: string;

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-mcp-signals-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-signals-cwd-'));
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
