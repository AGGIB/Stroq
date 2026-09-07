import type { Decision } from '@stroq/core';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { denyDirectly } from '../adapters/pre-decision.js';
import { isRecord } from '../adapters/tool-input.js';
import { logError } from '../log.js';
import {
  MAX_LINE_CHARS,
  asJsonRpcId,
  classifyMessage,
  isScannedMethod,
  paramsOf,
  parseLine,
  type PendingTable,
  type SplitLine,
} from './framing.js';
import {
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

/**
 * The message pumps: one function per direction that turns a `SplitLine` into
 * whatever the proxy does about it (forward, judge, scan, reply, drop). Split out of
 * `proxy.ts` — which keeps spawn/signal/shutdown lifecycle — to stay under the repo's
 * 400-line file cap; `runMcpProxy` owns the streams, the two `OrderedQueue`s and the
 * line splitters, and hands this module only what a line handler needs.
 */

/** A tools/call whose id `classifyMessage` could not use at all — e.g. `1e400`
 * parses to `Infinity`, which `asJsonRpcId` rejects as non-finite. Unlike
 * `judge.ts`'s `MCP_MALFORMED_CALL` (an invalid or missing TOOL NAME), the tool name
 * here may be perfectly fine; it is the id that makes no reply possible, so this
 * gets its own rule id rather than borrowing one whose reason names a different
 * defect. */
const MCP_UNADDRESSABLE_CALL: Decision = {
  effect: 'deny',
  ruleId: 'mcp-proxy-unaddressable-call',
  reason:
    'The tools/call carried a request id Stroq could not classify as a valid JSON-RPC id, so no reply can be addressed to it; denied fail-closed rather than forwarded unjudged.',
};

/** A client line naming `tools/call` that `JSON.parse` still rejects after a leading
 * byte-order mark is stripped. The reason names no content from the line itself,
 * which Stroq never got to read and which may carry a secret. */
const MCP_UNPARSEABLE_CALL: Decision = {
  effect: 'deny',
  ruleId: 'mcp-proxy-unparseable-call',
  reason:
    'A client line naming tools/call could not be parsed as JSON, so Stroq could not classify or judge it; denied fail-closed rather than forwarded unread.',
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One queue per direction, so lines are handled strictly in arrival order: the
 * session store is file-locked and the audit log is a hash chain, so two engine calls
 * must never overlap, and the order they run in is the order `stroq log` shows. A
 * task that throws is swallowed here — every task answers its own failures first — so
 * one bad line can never stall the stream behind it.
 */
export class OrderedQueue {
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
 * Honours backpressure in BOTH directions: `sink.write()` returning false means the
 * DESTINATION cannot keep up, so `source` — whichever stream is feeding the queue
 * that produced this write — is paused until the write actually drains. Without
 * this, a fast writer paired with a slow reader grows the queue without bound
 * (measured before this fix: 100k lines from a fast server against a slow-reading
 * client pushed this process's RSS past 380 MiB, with the server never slowed by
 * anything the proxy did). `error`/`close` end the wait too — a dead pipe must not
 * hang the queue behind it — and the source is resumed on every path, so a broken
 * destination cannot leave it paused forever.
 */
export async function writeBackpressured(
  sink: NodeJS.WritableStream,
  text: string,
  source: NodeJS.ReadableStream,
): Promise<void> {
  if (sink.write(text)) return;
  source.pause();
  await new Promise<void>((resolve) => {
    const done = (): void => {
      sink.off('drain', done);
      sink.off('error', done);
      sink.off('close', done);
      resolve();
    };
    sink.once('drain', done);
    sink.once('error', done);
    sink.once('close', done);
  });
  source.resume();
}

const BOM = '﻿';
const TOOLS_CALL_LIKE = /tools\/call/i;
const isToolsCall = (method: string): boolean => method.toLowerCase() === 'tools/call';

export interface PumpDeps {
  readonly ctx: McpContext;
  readonly pending: PendingTable;
  /** `options.stdin`: paused/resumed around every write a CLIENT line triggers, whichever stream it targets. */
  readonly clientIn: NodeJS.ReadableStream;
  /** The MCP server's stdin: where a forwarded (allowed) client line goes. */
  readonly serverIn: NodeJS.WritableStream;
  /** The MCP server's stdout: paused/resumed around every write a SERVER line triggers. */
  readonly serverOut: NodeJS.ReadableStream;
  /** `options.stdout`: where every reply and every forwarded server line goes. */
  readonly clientOut: NodeJS.WritableStream;
}

export interface Pump {
  readonly onClientLine: (line: SplitLine) => Promise<void>;
  readonly onServerLine: (line: SplitLine) => Promise<void>;
}

export function createPump(deps: PumpDeps): Pump {
  const { ctx, pending, clientIn, serverIn, serverOut, clientOut } = deps;

  // Every write triggered by handling a CLIENT line — a forward to the server, or a
  // reply written straight back to the client — is paused against `clientIn`:
  // whichever destination is slow, more client input must wait rather than pile up
  // in the queue unread.
  const fromClient = (sink: NodeJS.WritableStream, text: string): Promise<void> =>
    writeBackpressured(sink, text, clientIn);
  const forwardToServer = (line: SplitLine): Promise<void> =>
    fromClient(serverIn, `${line.text}${line.eol}`);
  const replyToClient = (value: unknown): Promise<void> =>
    fromClient(clientOut, `${JSON.stringify(value)}\n`);

  // Every write triggered by handling a SERVER line always lands on `clientOut` and
  // is paused against `serverOut`.
  const forwardToClient = (line: SplitLine): Promise<void> =>
    writeBackpressured(clientOut, `${line.text}${line.eol}`, serverOut);
  const replyFromResult = (value: unknown): Promise<void> =>
    writeBackpressured(clientOut, `${JSON.stringify(value)}\n`, serverOut);

  /** `mcpToolName`/`mcpCallInput`, applied the same way for every "could not classify this tools/call" audit path. */
  const callAuditFields = (
    params: Record<string, unknown>,
  ): { readonly toolName: string; readonly toolInput: Record<string, unknown> } => {
    const rawName = params['name'];
    return {
      toolName: mcpToolName(ctx.server, typeof rawName === 'string' ? rawName : ''),
      toolInput: mcpCallInput(params),
    };
  };

  /** The shared audit path for every "dropped, not forwarded, no reply possible or intended" case. */
  const auditDrop = (
    toolName: string,
    toolInput: Record<string, unknown>,
    decision: Decision,
    summary: string,
  ) =>
    denyDirectly(
      { sessionId: ctx.sessionId, toolName, toolInput, cwd: ctx.cwd },
      decision,
      summary,
      () => ({ stdout: '', exitCode: 0 }),
    );

  async function handleClientLine(line: SplitLine): Promise<void> {
    // Some servers (Jackson/.NET stacks are documented offenders) reject JSON
    // prefixed with a byte-order mark; `JSON.parse` rejects it too. Stripped only
    // for parsing — the ORIGINAL text (BOM included) is what a forward sends, so
    // forwarding stays byte-exact whichever way this goes.
    const unmarked = line.text.startsWith(BOM) ? line.text.slice(BOM.length) : line.text;
    const value = parseLine(unmarked);
    if (value === undefined) {
      // Still unreadable. Most non-JSON client lines are the client's own framing
      // business and go through untouched — but one that NAMES tools/call anywhere
      // in its text must not be forwarded blind: an adversarial JSON quirk (this
      // proxy cannot even identify which quirk without parsing) is exactly how a
      // secret-bearing call could dodge every check above it.
      if (!TOOLS_CALL_LIKE.test(line.text)) return forwardToServer(line);
      const { toolName, toolInput } = callAuditFields({});
      await auditDrop(
        toolName,
        toolInput,
        MCP_UNPARSEABLE_CALL,
        'mcp proxy: a client line naming tools/call could not be parsed as JSON',
      );
      return;
    }
    const message = classifyMessage(value);
    if (message.kind === 'batch') {
      if (!batchHasToolCall(message.items)) return forwardToServer(line);
      return replyToClient(await refuseBatch(ctx, message.items));
    }
    if (message.kind === 'notification') {
      if (message.method === 'notifications/cancelled') {
        const cancelled = asJsonRpcId(paramsOf(message.value)['requestId']);
        if (cancelled !== null) pending.cancel(cancelled);
        return forwardToServer(line);
      }
      if (isToolsCall(message.method)) {
        // `classifyMessage` reports this as a notification only because its `id`
        // failed `asJsonRpcId` (e.g. `1e400` parses to `Infinity`, which is not
        // finite). A tools/call this broken can address no reply, so it is DROPPED
        // rather than forwarded — the server must never see a tools/call Stroq
        // could not judge — and audited so `stroq log` still explains why.
        const params = paramsOf(message.value);
        const { toolName, toolInput } = callAuditFields(params);
        await auditDrop(
          toolName,
          toolInput,
          MCP_UNADDRESSABLE_CALL,
          'mcp proxy: tools/call with an id classifyMessage could not address',
        );
        return;
      }
      return forwardToServer(line);
    }
    if (message.kind !== 'request') return forwardToServer(line);
    if (isToolsCall(message.method)) {
      const params = paramsOf(message.value);
      try {
        const verdict = await judgeToolCall(ctx, message.value, message.id, params);
        if (verdict.pending !== null) pending.set(message.id, verdict.pending);
        if (verdict.forward) return forwardToServer(line);
        return verdict.reply === null ? undefined : replyToClient(verdict.reply);
      } catch (err) {
        // An engine that cannot answer must not become an allow: the call is
        // denied and never forwarded, with the reason where the model will read
        // it, and audited directly — the same trail a working `engine.pre` would
        // have left, just via the proxy's own path since the engine itself threw.
        logError('mcp proxy pre', err);
        const text = `Stroq internal error (fail-closed): ${messageOf(err)}`;
        const { toolName, toolInput } = callAuditFields(params);
        await auditDrop(
          toolName,
          toolInput,
          { effect: 'deny', ruleId: 'mcp-proxy-internal-error', reason: text },
          'mcp proxy: engine.pre threw while judging a tools/call',
        );
        return replyToClient(errorResponse(message.value, message.id, text));
      }
    }
    if (isScannedMethod(message.method))
      pending.set(message.id, {
        method: message.method,
        toolName: mcpMethodToolName(ctx.server, message.method),
      });
    return forwardToServer(line);
  }

  // Streaming mode only: true while the oversize server line under way has already
  // logged once. Scoped to this closure (one proxy run), not to any one line.
  let inLoggedOversizeRun = false;

  async function handleServerLine(line: SplitLine): Promise<void> {
    if (line.oversize) {
      // One entry per RUN of oversize segments, logged on the run's first segment
      // only — never keyed on an individual segment's text being empty, which a
      // legitimate mid-run chunk boundary can produce. Without this, one 10 MiB
      // line arriving as dozens of chunks logs dozens of times, each a synchronous
      // append carrying a full stack trace.
      if (!inLoggedOversizeRun) {
        logError(
          'mcp proxy',
          new Error(`server line above ${MAX_LINE_CHARS} characters forwarded without parsing`),
        );
        inLoggedOversizeRun = true;
      }
      // `eol === '\n'` — never text emptiness — is what closes the run.
      if (line.eol === '\n') inLoggedOversizeRun = false;
      return forwardToClient(line);
    }
    const value = parseLine(line.text);
    if (value === undefined) return forwardToClient(line);
    const message = classifyMessage(value);
    if (message.kind !== 'response') return forwardToClient(line);
    const entry = pending.take(message.id);
    if (entry === undefined) return forwardToClient(line);
    const result = message.value['result'];
    // A JSON-RPC error carries no tool result; there is nothing to scan.
    if (result === undefined) return forwardToClient(line);
    let warning: string | null = null;
    try {
      warning = await scanMcpResult(ctx, entry, result);
    } catch (err) {
      // Observe-only, exactly as every adapter's `post` already is: the result the
      // model asked for still reaches it, and the failure is recorded.
      logError('mcp proxy post', err);
      return forwardToClient(line);
    }
    // Only a `tools/call` result carries the warning: a listing or a resource
    // taints the session, and the next action is where that is enforced.
    if (warning === null || entry.method !== 'tools/call' || !isRecord(result))
      return forwardToClient(line);
    return replyFromResult({ ...message.value, result: withWarningBlock(result, warning) });
  }

  return {
    onClientLine: async (line: SplitLine): Promise<void> => {
      try {
        await handleClientLine(line);
      } catch (err) {
        logError('mcp proxy client line', err);
      }
    },
    onServerLine: async (line: SplitLine): Promise<void> => {
      try {
        await handleServerLine(line);
      } catch (err) {
        logError('mcp proxy server line', err);
      }
    },
  };
}
