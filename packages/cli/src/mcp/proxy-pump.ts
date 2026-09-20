import type { Decision } from '@stroq/core';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { denyDirectly } from '../adapters/pre-decision.js';
import { isRecord } from '../adapters/tool-input.js';
import { logError } from '../log.js';
import { EMPTY_PLAN, cloakNotice, type McpCloak, type UncloakPlan } from './cloak.js';
import { OrderedQueue, writeBackpressured } from './pump-stream.js';
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
  decisionText,
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

/**
 * `--cloak` only. A `tools/call` carrying a placeholder that stands for the value of
 * a credential this machine holds. The model never saw that value — it only ever saw
 * the placeholder — so restoring it here would be Stroq itself putting the credential
 * on the wire, which is the exact action `deny-secret-egress` exists to stop. The
 * reason names the credential the same way that rule does, and never its value.
 */
const cloakSecretRestore = (labels: readonly string[]): Decision => ({
  effect: 'deny',
  ruleId: 'mcp-cloak-secret-restore',
  reason:
    `The arguments carry a Stroq cloak placeholder standing for the value of a known secret (${labels.join(', ')}). ` +
    'Restoring it would send that value to this server, so the call is denied and the placeholder is not restored. ' +
    'Use the data the placeholder came from some other way, or turn the cloak off for this server if sending it is intended.',
});

/**
 * `--cloak` only. A server result the cloak could not read whole — an oversize line
 * (above `MAX_LINE_CHARS`, never parsed at all) or one that serialises past what the
 * detector scans. Delivering it would hand the model the very values the cloak was
 * turned on to withhold, so it is dropped instead. The client's request for it goes
 * unanswered, which is exactly what a server that never replied would cost, and a
 * hostile server can already do that at will.
 */
const CLOAK_UNSCANNABLE_RESULT: Decision = {
  effect: 'deny',
  ruleId: 'mcp-cloak-unscannable-result',
  reason:
    'The server result is larger than the cloak can read whole, so its values could not be replaced before the model saw them; the result is dropped rather than delivered uncloaked. Without --cloak this result would be forwarded unscanned.',
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Re-exported unchanged: `proxy.ts` imports `OrderedQueue` from here and
// `proxy-backpressure.test.ts` imports `writeBackpressured` from here, both as part
// of this module's own surface. The implementation lives in `pump-stream.ts` only to
// keep both files under the repo's line cap — the same split `judge.ts` makes with
// `mcp-result-text.ts`.
export { OrderedQueue, writeBackpressured };

const BOM = '﻿';
const TOOLS_CALL_LIKE = /tools\/call/i;
const isToolsCall = (method: string): boolean => method.toLowerCase() === 'tools/call';
const isCancelledNotification = (method: string): boolean =>
  method.toLowerCase() === 'notifications/cancelled';

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
  /**
   * `--cloak`, or null when the flag is absent — the default, and the shape every
   * pre-cloak test still exercises. When it is present, a `tools/call` RESULT is
   * rewritten before the model sees it and the forwarded REQUEST is rewritten before
   * the server does, so on those two paths the byte-exact forwarding this proxy
   * otherwise guarantees no longer holds. See the note in `framing.ts`.
   */
  readonly cloak?: McpCloak | null;
}

export interface Pump {
  readonly onClientLine: (line: SplitLine) => Promise<void>;
  readonly onServerLine: (line: SplitLine) => Promise<void>;
}

export function createPump(deps: PumpDeps): Pump {
  const { ctx, pending, clientIn, serverIn, serverOut, clientOut } = deps;
  const cloak = deps.cloak ?? null;

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

  /**
   * Forwards an allowed `tools/call`, restoring any cloaked values it carries. With
   * nothing to restore — every call when `--cloak` is off, and most of them when it
   * is on — the ORIGINAL line goes through byte for byte, key order and whitespace
   * included, exactly as it always has. Only a line that actually changed is
   * re-serialised, and only then is byte-exactness knowingly given up.
   */
  async function forwardWithRestores(
    line: SplitLine,
    message: Record<string, unknown>,
    params: Record<string, unknown>,
    plan: UncloakPlan,
  ): Promise<void> {
    if (cloak === null || plan.values.size === 0) {
      if (cloak !== null) await cloak.auditUncloak(callAuditFields(params).toolName, plan, []);
      return forwardToServer(line);
    }
    const applied = cloak.applyUncloak(params, plan);
    await cloak.auditUncloak(callAuditFields(params).toolName, plan, applied.replacements);
    return fromClient(serverIn, `${JSON.stringify({ ...message, params: applied.value })}\n`);
  }

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
      if (isCancelledNotification(message.method)) {
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
        // Resolved BEFORE the engine runs, but applied only after it allows. A
        // placeholder standing for a credential refuses the call outright; the rest
        // are restored on the forwarded line, which is safe in this order because the
        // kinds v1 restores carry no action class and no provenance atom — see the
        // ordering note at the top of `cloak.ts`.
        const plan = cloak === null ? EMPTY_PLAN : await cloak.planUncloak(params);
        if (plan.refused.length > 0) {
          const { toolName, toolInput } = callAuditFields(params);
          const decision = cloakSecretRestore(plan.refused);
          await auditDrop(
            toolName,
            toolInput,
            decision,
            `mcp cloak: tools/call carrying a secret placeholder (${plan.refused.join(', ')})`,
          );
          // Rendered through `decisionText` like every other deny this proxy writes,
          // so the model reads the same `Stroq blocked this action (<rule>): …` shape
          // and `stroq why` and the wire agree on the rule id.
          return replyToClient(
            errorResponse(message.value, message.id, decisionText(decision, [], [])),
          );
        }
        const verdict = await judgeToolCall(ctx, message.value, message.id, params);
        if (verdict.pending !== null) pending.set(message.id, verdict.pending);
        if (verdict.forward) return forwardWithRestores(line, message.value, params, plan);
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
      const first = !inLoggedOversizeRun;
      if (first) {
        logError(
          'mcp proxy',
          new Error(
            cloak === null
              ? `server line above ${MAX_LINE_CHARS} characters forwarded without parsing`
              : `server line above ${MAX_LINE_CHARS} characters dropped: --cloak cannot read it`,
          ),
        );
        inLoggedOversizeRun = true;
      }
      // `eol === '\n'` — never text emptiness — is what closes the run.
      if (line.eol === '\n') inLoggedOversizeRun = false;
      if (cloak === null) return forwardToClient(line);
      // Under --cloak the run is DROPPED, every segment of it: the line is never
      // parsed, so its values can neither be found nor replaced, and forwarding it
      // would deliver in full exactly what the cloak was switched on to withhold.
      // Audited once per run, on the same first segment the log fires on.
      if (first)
        await auditDrop(
          mcpToolName(ctx.server, 'oversize_result'),
          {},
          CLOAK_UNSCANNABLE_RESULT,
          `mcp cloak: a server line above ${MAX_LINE_CHARS} characters was dropped unread`,
        );
      return;
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
    // The cloak runs AFTER the scan, and on a `tools/call` result only. After,
    // because the scan and the provenance atoms are a record of what the server
    // actually sent — rewriting first would make `stroq log` describe Stroq's own
    // output. `tools/call` only, because a `tools/list` is a schema the client caches
    // and validates against, and rewriting a tool description or an input schema
    // would break the client rather than protect anyone.
    let cloaked: unknown = result;
    let notice: string | null = null;
    if (cloak !== null && entry.method === 'tools/call' && isRecord(result)) {
      const outcome = await cloak.cloakResult(result);
      if (outcome.kind === 'refused') {
        await auditDrop(
          entry.toolName,
          { method: entry.method },
          CLOAK_UNSCANNABLE_RESULT,
          `mcp cloak: a tools/call result was dropped unsent (${outcome.reason})`,
        );
        return;
      }
      if (outcome.kind === 'cloaked') {
        await cloak.auditCloak(entry.toolName, outcome);
        cloaked = outcome.result;
        notice = cloakNotice(outcome.replacements);
      }
    }
    // Only a `tools/call` result carries the warning: a listing or a resource
    // taints the session, and the next action is where that is enforced.
    const warns = warning !== null && entry.method === 'tools/call' && isRecord(result);
    if (!warns && notice === null) return forwardToClient(line);
    // `cloaked` came from `result`, which `isRecord` already accepted, and
    // `mapStrings` preserves the shape — so this is a record whenever either branch
    // above put something in it.
    let out = isRecord(cloaked) ? cloaked : (result as Record<string, unknown>);
    if (warns && warning !== null) out = withWarningBlock(out, warning);
    if (notice !== null) out = withWarningBlock(out, notice);
    return replyFromResult({ ...message.value, result: out });
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
