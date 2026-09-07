import { spawn } from 'node:child_process';
import type { StroqEngine } from '@stroq/core';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { denyDirectly, type EngineEvent } from '../adapters/pre-decision.js';
import { isRecord } from '../adapters/tool-input.js';
import { logError } from '../log.js';
import {
  MAX_LINE_CHARS,
  PendingTable,
  asJsonRpcId,
  classifyMessage,
  createLineSplitter,
  isScannedMethod,
  paramsOf,
  parseLine,
  type SplitLine,
} from './framing.js';
import {
  MCP_MALFORMED_CALL,
  batchHasToolCall,
  errorResponse,
  judgeToolCall,
  mcpCallInput,
  mcpMethodToolName,
  refuseBatch,
  scanMcpResult,
  withWarningBlock,
  type McpContext,
} from './judge.js';

/** How long the server gets to exit after its stdin ends, and again after SIGTERM. */
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
}

/**
 * One queue per direction, so lines are handled strictly in arrival order: the
 * session store is file-locked and the audit log is a hash chain, so two engine calls
 * must never overlap, and the order they run in is the order `stroq log` shows. A
 * task that throws is swallowed here — every task answers its own failures first — so
 * one bad line can never stall the stream behind it.
 */
class OrderedQueue {
  private tail: Promise<void> = Promise.resolve();

  run(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).then(
      () => undefined,
      () => undefined,
    );
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * Honours backpressure: a client that has stopped reading must slow the proxy down,
 * never lose a line. `error`/`close` end the wait too, so a dead pipe does not hang
 * the queue behind it.
 */
async function write(stream: NodeJS.WritableStream, text: string): Promise<void> {
  if (stream.write(text)) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      stream.off('drain', done);
      stream.off('error', done);
      stream.off('close', done);
      resolve();
    };
    stream.once('drain', done);
    stream.once('error', done);
    stream.once('close', done);
  });
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runMcpProxy(options: McpProxyOptions): Promise<number> {
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

  // A server that dies mid-write makes these emit `EPIPE`; an unhandled `error` on a
  // stream is a crash, and a crashed proxy is a client with no firewall.
  serverIn.on('error', (err: Error) => logError('mcp proxy server stdin', err));
  options.stdout.on('error', (err: Error) => logError('mcp proxy stdout', err));

  const forward = (stream: NodeJS.WritableStream, line: SplitLine): Promise<void> =>
    write(stream, `${line.text}${line.eol}`);
  const reply = (value: unknown): Promise<void> =>
    write(options.stdout, `${JSON.stringify(value)}\n`);

  async function handleClientLine(line: SplitLine): Promise<void> {
    const value = parseLine(line.text);
    // The client is trusted on framing; only the server is the adversary here. A line
    // Stroq cannot read is the client's business, so it goes through untouched.
    if (value === undefined) return forward(serverIn, line);
    const message = classifyMessage(value);
    if (message.kind === 'batch') {
      if (!batchHasToolCall(message.items)) return forward(serverIn, line);
      return reply(await refuseBatch(ctx, message.items));
    }
    if (message.kind === 'notification') {
      if (message.method === 'notifications/cancelled') {
        const cancelled = asJsonRpcId(paramsOf(message.value)['requestId']);
        if (cancelled !== null) pending.cancel(cancelled);
        return forward(serverIn, line);
      }
      if (message.method === 'tools/call') {
        // `classifyMessage` reports this as a notification only because its `id`
        // failed `asJsonRpcId` (e.g. `1e400` parses to `Infinity`, which is not
        // finite). A tools/call this broken can address no reply, so it is DROPPED
        // rather than forwarded — the server must never see a tools/call Stroq could
        // not judge — and audited so `stroq log` still explains why it never arrived.
        const params = paramsOf(message.value);
        const rawName = params['name'];
        const toolName = mcpToolName(ctx.server, typeof rawName === 'string' ? rawName : '');
        const toolInput = mcpCallInput(params);
        const event: EngineEvent = { sessionId: ctx.sessionId, toolName, toolInput, cwd: ctx.cwd };
        await denyDirectly(
          event,
          MCP_MALFORMED_CALL,
          'mcp proxy: tools/call with an id classifyMessage could not address',
          () => ({ stdout: '', exitCode: 0 }),
        );
        return;
      }
      return forward(serverIn, line);
    }
    if (message.kind !== 'request') return forward(serverIn, line);
    if (message.method === 'tools/call') {
      try {
        const verdict = await judgeToolCall(
          ctx,
          message.value,
          message.id,
          paramsOf(message.value),
        );
        if (verdict.pending !== null) pending.set(message.id, verdict.pending);
        if (verdict.forward) return forward(serverIn, line);
        return verdict.reply === null ? undefined : reply(verdict.reply);
      } catch (err) {
        // An engine that cannot answer must not become an allow: the call is denied
        // and never forwarded, with the reason where the model will read it.
        logError('mcp proxy pre', err);
        return reply(
          errorResponse(
            message.value,
            message.id,
            `Stroq internal error (fail-closed): ${messageOf(err)}`,
          ),
        );
      }
    }
    if (isScannedMethod(message.method))
      pending.set(message.id, {
        method: message.method,
        toolName: mcpMethodToolName(ctx.server, message.method),
      });
    return forward(serverIn, line);
  }

  async function handleServerLine(line: SplitLine): Promise<void> {
    if (line.oversize) {
      logError(
        'mcp proxy',
        new Error(`server line above ${MAX_LINE_CHARS} characters forwarded without parsing`),
      );
      return forward(options.stdout, line);
    }
    const value = parseLine(line.text);
    if (value === undefined) return forward(options.stdout, line);
    const message = classifyMessage(value);
    if (message.kind !== 'response') return forward(options.stdout, line);
    const entry = pending.take(message.id);
    if (entry === undefined) return forward(options.stdout, line);
    const result = message.value['result'];
    // A JSON-RPC error carries no tool result; there is nothing to scan.
    if (result === undefined) return forward(options.stdout, line);
    let warning: string | null = null;
    try {
      warning = await scanMcpResult(ctx, entry, result);
    } catch (err) {
      // Observe-only, exactly as every adapter's `post` already is: the result the
      // model asked for still reaches it, and the failure is recorded.
      logError('mcp proxy post', err);
      return forward(options.stdout, line);
    }
    // Only a `tools/call` result carries the warning: a listing or a resource taints
    // the session, and the next action is where that is enforced.
    if (warning === null || entry.method !== 'tools/call' || !isRecord(result))
      return forward(options.stdout, line);
    return reply({ ...message.value, result: withWarningBlock(result, warning) });
  }

  const onClientLine = async (line: SplitLine): Promise<void> => {
    try {
      await handleClientLine(line);
    } catch (err) {
      logError('mcp proxy client line', err);
    }
  };
  const onServerLine = async (line: SplitLine): Promise<void> => {
    try {
      await handleServerLine(line);
    } catch (err) {
      logError('mcp proxy server line', err);
    }
  };

  options.stdin.setEncoding('utf8');
  serverOut.setEncoding('utf8');
  options.stdin.on('data', (chunk: string) => {
    for (const line of clientLines.push(chunk)) toServer.run(() => onClientLine(line));
  });
  serverOut.on('data', (chunk: string) => {
    for (const line of serverLines.push(chunk)) toClient.run(() => onServerLine(line));
  });

  let termTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  options.stdin.on('end', () => {
    toServer.run(async () => {
      for (const line of clientLines.flush()) await onClientLine(line);
      serverIn.end();
      // The client is gone. The server gets a grace period to notice its stdin
      // closed, then SIGTERM, then SIGKILL: one that ignores both would otherwise
      // outlive the client it was launched for.
      termTimer = setTimeout(() => child.kill('SIGTERM'), SHUTDOWN_GRACE_MS);
      killTimer = setTimeout(() => child.kill('SIGKILL'), SHUTDOWN_GRACE_MS * 2);
    });
  });

  const relay = (signal: NodeJS.Signals) => (): void => {
    child.kill(signal);
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

  if (termTimer !== null) clearTimeout(termTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  for (const line of serverLines.flush()) toClient.run(() => onServerLine(line));
  await toClient.idle();
  await toServer.idle();
  // A client whose own stdin is still open would keep this process alive forever,
  // now that there is no server left to talk to.
  options.stdin.removeAllListeners('data');
  options.stdin.pause();
  return code;
}
