import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine-factory.js';
import { runMcpProxy } from '../../src/mcp/proxy.js';

/**
 * The MCP server can die while the client is still talking. Every line that arrives
 * after that is written to a pipe whose reader is gone: `write()` on an already
 * destroyed stream returns false and then emits NOTHING — `drain`, `error` and
 * `close` all fired once, when the stream died, and an `EventEmitter` never replays
 * a past event to a listener attached afterwards. Without `writeBackpressured`'s
 * dead-sink check the proxy waits on those events forever, keeps `options.stdin`
 * paused, and `await toServer.idle()` in `runMcpProxy` never resolves — the process
 * hangs for good (measured before this fix: no exit within 20 s, against 131 ms for
 * the same run with no lines sent after the server's death).
 *
 * The per-test timeout is deliberate: against the unfixed code this file must FAIL
 * FAST rather than hang the worker, so the hang is caught in seconds here instead of
 * being reproduced at full scale.
 */

const exitAfterReplyServer = join(import.meta.dirname, 'exit-after-reply-server.mjs');
/** Distinctive and non-zero, so "the server's own code" cannot be confused with a default. */
const SERVER_EXIT_CODE = 7;
/**
 * Comfortably past both the server stdin socket's 16 KiB high-water mark and the
 * OS pipe buffer, so the FIRST of these lines cannot be handed straight to the
 * kernel: it backs up, which is what keeps the rest of them queued behind it while
 * the server dies. Written as one padded `initialize` param, so nothing about the
 * line is unusual apart from its size.
 */
const PADDING_CHARS = 40 * 1024;
/** Deep enough that many are still queued when the server's stdin is destroyed. */
const LINES_AFTER_FIRST = 12;

let cwd: string;
let openStreams: PassThrough[] = [];

beforeEach(() => {
  process.env['STROQ_HOME'] = mkdtempSync(join(tmpdir(), 'stroq-mcp-dead-sink-'));
  cwd = mkdtempSync(join(tmpdir(), 'stroq-mcp-dead-sink-cwd-'));
  // The stub inherits the proxy's environment, which is this worker's.
  process.env['EXIT_AFTER_REPLY_EXIT_CODE'] = String(SERVER_EXIT_CODE);
  openStreams = [];
});

afterEach(() => {
  // Best effort only: `runMcpProxy` does not expose the child it spawns, so this
  // cannot reach it — but in THIS scenario the server has already exited by the
  // time the bug would bite, so what a timed-out run leaks is a reference to these
  // streams, never an orphaned process.
  for (const stream of openStreams) stream.destroy();
});

/** The three caller-supplied streams a proxy run needs, registered for teardown. */
function proxyStreams(): {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  openStreams = [...openStreams, stdin, stdout, stderr];
  return { stdin, stdout, stderr };
}

const initialize = (id: number, padding = ''): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { padding } })}\n`;

describe('a client that keeps writing after the MCP server has died', () => {
  it(
    'drops what the dead pipe can no longer take and still exits with the server exit code',
    { timeout: 5000 },
    async () => {
      const { stdin, stdout, stderr } = proxyStreams();
      // Drained, so what this measures is the SERVER's dead pipe and never an
      // unread client one backing up behind it.
      stdout.resume();

      const done = runMcpProxy({
        engine: createEngine(),
        sessionId: 'mcp:test',
        server: 'demo',
        cwd,
        command: process.execPath,
        args: [exitAfterReplyServer],
        stdin,
        stdout,
        stderr,
      });

      // The stub answers this first request and then exits, which is what destroys
      // the proxy's end of its stdin pipe.
      stdin.write(initialize(1));
      // Written in the same breath, and deliberately too big to hand straight to
      // the kernel: the first of them backs up, so the rest are still sitting in
      // the client-direction queue when the server dies underneath them. Spacing
      // these out instead would just race the exit — every one of them would be
      // handed over before the socket noticed, and nothing would be proven.
      const padding = 'x'.repeat(PADDING_CHARS);
      for (let id = 2; id <= LINES_AFTER_FIRST + 1; id += 1) stdin.write(initialize(id, padding));
      stdin.end();
      const clientDone = Date.now();

      // Both halves of the finding: the run ENDS (the per-test timeout is what
      // fails otherwise), and it ends promptly with the server's own code rather
      // than sitting out a grace period first.
      expect(await done).toBe(SERVER_EXIT_CODE);
      expect(Date.now() - clientDone).toBeLessThan(2000);
    },
  );
});
