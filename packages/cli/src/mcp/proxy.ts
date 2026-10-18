import { spawn } from 'node:child_process';
import type { StroqEngine } from '@stroq/core';
import { logError } from '../log.js';
import { createMcpCloak } from './cloak-factory.js';
import { childEnv } from './child-env.js';
import { PendingTable, createLineSplitter, type SplitLine } from './framing.js';
import type { McpContext } from './judge.js';
import { killChildTree } from './kill-child.js';
import { BIND_PHRASES, PIN_SANDBOX_PHRASES, reconfirmCommand } from './pin-argument.js';
import type { Launch } from './pin-binding.js';
import { OrderedQueue, createPump, type StrictPumpDeps } from './proxy-pump.js';
import { StrictLedger } from './strict-ledger.js';
import {
  DEFAULT_STRICT_MAX_WITHHELD,
  STRICT_MAX_QUEUED_CHARS,
  STRICT_MAX_QUEUED_LINES,
  STRICT_SCAN_DEADLINE_MS,
} from './strict-limits.js';
import { createQueueGate } from './strict-queue.js';
import { createBoundedScan } from './strict-scan.js';

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
  /**
   * The environment variable names this server may have on top of `childEnv`'s
   * infrastructure list: `--pass-env`, which `init` records from the config entry's
   * own `env` block. `null` is a wrapper written before that flag existed, which
   * carries no such record — the server then inherits the whole environment, as it
   * always did. That is the migration path, not the intended state, and `runMcp`
   * says so on stderr.
   */
  readonly passEnv: readonly string[] | null;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  /** The proxy's OWN diagnostics. The server's stderr is inherited at the fd, never piped. */
  readonly stderr: NodeJS.WritableStream;
  /** Overrides `SHUTDOWN_GRACE_MS` for both the EOF and the signal-escalation shutdown paths; tests only. */
  readonly shutdownGraceMs?: number;
  /**
   * `--cloak`: replace detected values in a `tools/call` result before the model
   * reads it, and restore them on the way back to this server. OFF by default,
   * because it changes what a third-party server receives and writes a reversible
   * dictionary to disk; both are decisions to be asked for, not defaults.
   */
  readonly cloak?: boolean;
  /**
   * `--strict`: never deliver to the client a server message Stroq could not fully
   * read and scan; withhold it, answer the client's request with a fixed error, audit
   * it and count it against `strictMaxWithheld`. OFF by default, because it refuses
   * messages the default proxy forwards and re-serialises the ones it delivers. See
   * `strict-handler.ts`.
   */
  readonly strict?: boolean;
  /** How many withheld messages end a strict server; `DEFAULT_STRICT_MAX_WITHHELD` when absent. */
  readonly strictMaxWithheld?: number;
  /** Overrides `STRICT_SCAN_DEADLINE_MS`, the hard time bound on scanning one message; tests only. */
  readonly strictScanMs?: number;
  /** Overrides `STRICT_MAX_BENIGN_WITHHELD`, the cap for the withheld kinds a benign server also sends; tests only. */
  readonly strictMaxBenign?: number;
  readonly pin?: string;
  /** The command line this proxy was started with, whole; the pin compares it with what `add` wrote. */
  readonly launch?: Launch;
}

export async function runMcpProxy(options: McpProxyOptions): Promise<number> {
  if (options.pin === undefined) return runProxy(options);
  let pinned;
  try {
    const { preparePin } = await import('./pin.js');
    pinned = await preparePin({ ...options, pin: options.pin });
  } catch (error) {
    options.stderr.write(`stroq mcp: ${pinRefusal(error, options.server)}; refusing to start\n`);
    return 1;
  }
  try {
    return await runProxy(
      { ...options, command: pinned.command, args: pinned.args, passEnv: options.passEnv ?? [] },
      pinned.cwd,
    );
  } finally {
    await pinned.cleanup().catch(() => {
      options.stderr.write(
        'stroq mcp: could not remove the private server copy; remove it after the server stops\n',
      );
    });
  }
}

/** Only fixed diagnostic phrases may reach stderr; filesystem errors can contain untrusted paths. */
function pinRefusal(error: unknown, server: string): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'the local confirmation lock exceeds the size limit') return message;
  if (message === 'the local MCP confirmation lock is missing or invalid') return message;
  if (message === 'this server and digest are not confirmed on this machine') return message;
  if (message === 'the pinned server files changed (digest mismatch)') return message;
  if (message === 'the stored manifest digest changed') return message;
  if (message === 'cannot verify a linked store folder') return message;
  if (message === 'cannot verify a linked pin record') return message;
  if (message === 'cannot verify a bounded regular pin record') return message;
  if (message === 'cannot verify all files of the pinned tree') return message;
  if (message === 'cannot use a runtime folder owned by another user') return message;
  // A wrapper that is not the one confirmed: the phrase, and the command that confirms the wrapper as it stands.
  if (BIND_PHRASES.includes(message))
    return `${message} (to confirm it again run: ${reconfirmCommand(server)})`;
  if (PIN_SANDBOX_PHRASES.some((phrase) => phrase === message)) return message;
  return 'pinned server cannot be verified';
}

async function runProxy(options: McpProxyOptions, serverCwd?: string): Promise<number> {
  const graceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  // Unpinned servers keep the client's cwd; pinned servers run in the private copy.
  // `inherit` on fd 2 hands the server the proxy's own stderr, so its logging reaches the client
  // untouched and is never parsed as a message. The environment is NOT inherited
  // whole — the proxy holds the user's entire shell, and a wrapped server gets only
  // what `childEnv` allows; a legacy wrapper (`passEnv === null`) is the one case
  // where it still does, because nothing recorded what that server actually needs.
  const child = spawn(options.command, [...options.args], {
    ...(serverCwd === undefined ? {} : { cwd: serverCwd }),
    ...(options.passEnv === null ? {} : { env: childEnv(options.passEnv) }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const serverIn = child.stdin;
  const serverOut = child.stdout;
  if (serverIn === null || serverOut === null) {
    options.stderr.write('stroq mcp: the MCP server was spawned without stdio pipes\n');
    killChildTree(child, 'SIGKILL');
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
  // `terminate` runs well after this function has defined `onSigterm` below: it is only
  // ever called from a server line, never while this setup is still running.
  const strict: StrictPumpDeps | null =
    options.strict === true
      ? {
          ledger: new StrictLedger(),
          maxWithheld: options.strictMaxWithheld ?? DEFAULT_STRICT_MAX_WITHHELD,
          ...(options.strictMaxBenign === undefined ? {} : { maxBenign: options.strictMaxBenign }),
          scan: createBoundedScan(options.strictScanMs ?? STRICT_SCAN_DEADLINE_MS),
          terminate: () => onSigterm(),
          note: (text) => options.stderr.write(text),
        }
      : null;
  const pump = createPump({
    ctx,
    pending,
    clientIn: options.stdin,
    serverIn,
    serverOut,
    clientOut: options.stdout,
    cloak: options.cloak === true ? createMcpCloak(ctx) : null,
    strict,
  });
  // Strict mode only: the default proxy is bounded by write backpressure, which a
  // withheld (never written) line does not exercise. See `strict-queue.ts`.
  const gate =
    strict === null
      ? null
      : createQueueGate(serverOut, STRICT_MAX_QUEUED_LINES, STRICT_MAX_QUEUED_CHARS);
  const queueServerLine = (line: SplitLine): void => {
    if (gate === null) {
      toClient.run(() => pump.onServerLine(line));
      return;
    }
    gate.enter(line.text.length);
    toClient.run(async () => {
      try {
        await pump.onServerLine(line);
      } finally {
        gate.leave(line.text.length);
      }
    });
  };

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
    for (const line of serverLines.push(chunk)) queueServerLine(line);
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
      // outlive the client it was launched for. On Windows the two rungs collapse
      // into one — every signal there is a TerminateProcess — so what the ladder
      // actually buys on that platform is the grace period, and the reach comes
      // from `killChildTree` walking the tree rather than from the escalation.
      termTimer = setTimeout(() => killChildTree(child, 'SIGTERM'), graceMs);
      killTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), graceMs * 2);
    });
  });

  // A server that ignores the relayed signal must not keep both processes alive
  // forever: escalate to SIGKILL after the same grace period the EOF path uses.
  // Guarded so a second signal (e.g. SIGINT right after SIGTERM) does not arm a
  // second, redundant timer.
  let signalKillTimer: NodeJS.Timeout | null = null;
  const relay = (signal: NodeJS.Signals) => (): void => {
    // The server has closed: there is nothing left to signal, and a signal sent to its
    // process id now could reach whatever has taken that id. Strict mode asks for the
    // server to be stopped while the lines it wrote before closing are still being
    // worked through, which is after the close; this is also what stops that from
    // arming a kill timer nothing would clear.
    if (shuttingDown) return;
    killChildTree(child, signal);
    if (signalKillTimer === null)
      signalKillTimer = setTimeout(() => killChildTree(child, 'SIGKILL'), graceMs);
  };
  const onSigint = relay('SIGINT');
  const onSigterm = relay('SIGTERM');
  const onSighup = relay('SIGHUP');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);

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
  process.off('SIGHUP', onSighup);
  for (const line of serverLines.flush()) queueServerLine(line);
  await toClient.idle();
  await toServer.idle();
  // Cleared a second time, now that both queues have drained. The guard above and
  // the arming under it are one synchronous block, so the guard alone is what makes
  // a stale timer impossible — but the clear is a line, and having it here means
  // "no timer this run armed outlives it" holds by reading this function, rather
  // than by reasoning about which task ran in which turn.
  if (termTimer !== null) clearTimeout(termTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  if (signalKillTimer !== null) clearTimeout(signalKillTimer);
  // A client whose own stdin is still open would keep this process alive forever,
  // now that there is no server left to talk to. Removes only the ONE listener this
  // function registered — `options.stdin` is caller-supplied, and a caller may have
  // its own instrumentation on the same stream.
  options.stdin.off('data', onStdinData);
  options.stdin.pause();
  // A strict server that was ended for too many withheld messages exits non-zero even
  // when it said goodbye politely on the way out.
  return pump.strictTerminated?.() === true && code === 0 ? 1 : code;
}
