import { spawn } from 'node:child_process';
import type { StroqEngine } from '@stroq/core';
import { logError } from '../log.js';
import { PendingTable, createLineSplitter } from './framing.js';
import type { McpContext } from './judge.js';
import { OrderedQueue, createPump } from './proxy-pump.js';

/**
 * Spawn, signal handling and shutdown lifecycle for the MCP proxy. The per-line
 * judging/scanning/forwarding logic lives in `proxy-pump.ts` — split out to keep
 * both files under the repo's 400-line cap; this file owns the streams, the two
 * `OrderedQueue`s and the line splitters, and hands `createPump` only what a line
 * handler needs.
 */

/** How long the server gets to exit after its stdin ends, or after a relayed signal, before an escalation. */
export const SHUTDOWN_GRACE_MS = 2000;

export interface McpProxyOptions {
  readonly engine: StroqEngine;
  readonly sessionId: string;
  /** The trusted server name, from `--server`. */
  readonly server: string;
  /** The policy directory, from `--cwd` or the proxy's own. */
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  /** The proxy's OWN diagnostics. The server's stderr is inherited at the fd, never piped. */
  readonly stderr: NodeJS.WritableStream;
  /** Overrides `SHUTDOWN_GRACE_MS` for both the EOF and the signal-escalation shutdown paths; tests only. */
  readonly shutdownGraceMs?: number;
}

export async function runMcpProxy(options: McpProxyOptions): Promise<number> {
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  // No `env` and no `cwd`: the server inherits the proxy's, which is what the client
  // gave it. `inherit` on fd 2 hands the server the proxy's own stderr, so its
  // logging reaches the client untouched and is never parsed as a message.
  const child = spawn(options.command, [...options.args], { stdio: ['pipe', 'pipe', 'inherit'] });
  const serverIn = child.stdin;
  const serverOut = child.stdout;
  if (serverIn === null || serverOut === null) {
    options.stderr.write('stroq mcp: the MCP server was spawned without stdio pipes\n');
    child.kill('SIGKILL');
    return 1;
  }
  const ctx: McpContext = {
    engine: options.engine,
    sessionId: options.sessionId,
    server: options.server,
    cwd: options.cwd,
  };
  const pending = new PendingTable();
  const toServer = new OrderedQueue();
  const toClient = new OrderedQueue();
  const clientLines = createLineSplitter();
  // Streaming mode: a server line above MAX_LINE_CHARS arrives as a run of oversize
  // segments forwarded verbatim as they come in, so one hostile server response can
  // never grow this process's memory without bound. Client lines are always buffered
  // whole (the default below) — a `tools/call` is exactly what Stroq exists to judge,
  // and streaming a big one through unparsed would be exactly the bypass.
  const serverLines = createLineSplitter({ streamOversize: true });
  const pump = createPump({
    ctx,
    pending,
    clientIn: options.stdin,
    serverIn,
    serverOut,
    clientOut: options.stdout,
  });

  // A server that dies mid-write makes these emit `EPIPE`; an unhandled `error` on a
  // stream is a crash, and a crashed proxy is a client with no firewall.
  serverIn.on('error', (err: Error) => logError('mcp proxy server stdin', err));
  options.stdout.on('error', (err: Error) => logError('mcp proxy stdout', err));

  options.stdin.setEncoding('utf8');
  serverOut.setEncoding('utf8');
  const onStdinData = (chunk: string): void => {
    for (const line of clientLines.push(chunk)) toServer.run(() => pump.onClientLine(line));
  };
  options.stdin.on('data', onStdinData);
  serverOut.on('data', (chunk: string) => {
    for (const line of serverLines.push(chunk)) toClient.run(() => pump.onServerLine(line));
  });

  // Set once the child has closed, right before the timers below are first cleared.
  // The EOF handler runs inside a QUEUED `toServer` task, so a client that closes
  // its end while the proxy is still draining can reach it AFTER that clearing —
  // and a kill armed from there is one nothing will ever cancel, holding the event
  // loop open for twice the grace period aimed at a server that has already gone.
  let shuttingDown = false;
  let termTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  options.stdin.on('end', () => {
    toServer.run(async () => {
      for (const line of clientLines.flush()) await pump.onClientLine(line);
      serverIn.end();
      if (shuttingDown) return;
      // The client is gone. The server gets a grace period to notice its stdin
      // closed, then SIGTERM, then SIGKILL: one that ignores both would otherwise
      // outlive the client it was launched for.
      termTimer = setTimeout(() => child.kill('SIGTERM'), graceMs);
      killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs * 2);
    });
  });

  // A server that ignores the relayed signal must not keep both processes alive
  // forever: escalate to SIGKILL after the same grace period the EOF path uses.
  // Guarded so a second signal (e.g. SIGINT right after SIGTERM) does not arm a
  // second, redundant timer.
  let signalKillTimer: NodeJS.Timeout | null = null;
  const relay = (signal: NodeJS.Signals) => (): void => {
    child.kill(signal);
    if (signalKillTimer === null)
      signalKillTimer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  };
  const onSigint = relay('SIGINT');
  const onSigterm = relay('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  const code = await new Promise<number>((resolve) => {
    child.on('error', (err: Error) => {
      options.stderr.write(`stroq mcp: cannot start the MCP server: ${err.message}\n`);
      resolve(1);
    });
    // `close` rather than `exit`: the server's stdout is fully drained by then, so
    // nothing it said last is lost.
    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      resolve(signal === null ? (exitCode ?? 1) : 1);
    });
  });

  shuttingDown = true;
  if (termTimer !== null) clearTimeout(termTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  if (signalKillTimer !== null) clearTimeout(signalKillTimer);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  for (const line of serverLines.flush()) toClient.run(() => pump.onServerLine(line));
  await toClient.idle();
  await toServer.idle();
  // Cleared a second time, now that both queues have drained. The guard above and
  // the arming under it are one synchronous block, so the guard alone is what makes
  // a stale timer impossible — but the clear is a line, and having it here means
  // "no timer this run armed outlives it" holds by reading this function, rather
  // than by reasoning about which task ran in which turn.
  if (termTimer !== null) clearTimeout(termTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  // A client whose own stdin is still open would keep this process alive forever,
  // now that there is no server left to talk to. Removes only the ONE listener this
  // function registered — `options.stdin` is caller-supplied, and a caller may have
  // its own instrumentation on the same stream.
  options.stdin.off('data', onStdinData);
  options.stdin.pause();
  return code;
}
