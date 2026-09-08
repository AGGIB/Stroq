import type { Decision, ProvenanceHit, SecretHit, StroqEngine } from '@stroq/core';
import { MAX_SCAN_CHARS } from '@stroq/core';
import { withEvidence } from '../adapters/claude-code.js';
import { describeToolInput } from '../adapters/codex-input.js';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import {
  decidePre,
  denyDirectly,
  scanPostResult,
  type EngineEvent,
} from '../adapters/pre-decision.js';
import { isRecord, toolInputRecord } from '../adapters/tool-input.js';
import {
  asJsonRpcId,
  hasProtocolMeta,
  jsonrpcOf,
  paramsOf,
  type JsonRpcId,
  type PendingRequest,
  type ScannedMethod,
} from './framing.js';
import { MCP_MAX_RESULT_CHARS, mcpResultText, resultTextFor } from './mcp-result-text.js';

// Re-exported unchanged: callers (Task 4's `proxy.ts`) import these from `judge.js`
// as part of this module's own surface. The implementation lives in
// `mcp-result-text.ts` only to keep both files under the repo's line cap.
export { MCP_MAX_RESULT_CHARS, mcpResultText, resultTextFor };

/**
 * Everything the MCP proxy asks the engine, and every shape it writes back. The
 * process wiring is `proxy.ts`; this module is pure apart from the two engine calls,
 * which is why it can be tested against a real engine without a subprocess.
 */

export interface McpContext {
  readonly engine: StroqEngine;
  /** `--session`, else `mcp:<client>`. One session per client, so server A taints server B. */
  readonly sessionId: string;
  /** The config key `--server` gave: the TRUSTED server name, never read from the wire. */
  readonly server: string;
  /** `--cwd`, else the proxy's own directory. Nothing on the wire changes it. */
  readonly cwd: string;
}

/**
 * The tool-name suffix each scanned method audits under. `tools/call` never uses its
 * entry — its name comes from `params.name` — but the record is total so no method
 * can be added without deciding what it is called.
 */
export const MCP_METHOD_TOOL: Readonly<Record<ScannedMethod, string>> = {
  'tools/call': 'call',
  'tools/list': 'tools_list',
  'resources/read': 'resources_read',
  'prompts/get': 'prompts_get',
};

export const mcpMethodToolName = (server: string, method: ScannedMethod): string =>
  mcpToolName(server, MCP_METHOD_TOOL[method]);

/**
 * The arguments as they are, never reduced: the secret-egress guard scans
 * `JSON.stringify(toolInput)` in windows up to `MAX_SCAN_CHARS` (2 MiB), so a field dropped here
 * is a value that can never be caught leaving through this call — and a record that
 * serialises past that window is refused outright by `judgeToolCall` rather than
 * handed to a scan that would see only part of it. A modern retry's `inputResponses` ride along
 * under their own key so the retry is judged on what it actually carries — but a
 * hostile server can declare a tool parameter literally named `inputResponses` and
 * tell the model to put a credential there, so the top-level field is never allowed
 * to overwrite one the arguments already carried: when the key collides, the retry's
 * value is kept under the next free `inputResponses_…` key instead, so both are seen.
 */
export function mcpCallInput(params: Record<string, unknown>): Record<string, unknown> {
  const record = toolInputRecord(params['arguments']);
  const responses = params['inputResponses'];
  if (responses === undefined) return record;
  let key = 'inputResponses';
  while (Object.hasOwn(record, key)) key += '_';
  return { ...record, [key]: responses };
}

/**
 * A tool EXECUTION error, which the MCP spec says clients SHOULD show the model so it
 * can self-correct — not a JSON-RPC protocol error, which they need not show at all.
 * `resultType` appears only for a request that declared the modern protocol: a reply
 * that omits it for a modern client is malformed, and one that adds it for a legacy
 * client is an unknown key.
 */
export function errorResult(
  message: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...(hasProtocolMeta(message) ? { resultType: 'complete' } : {}),
  };
}

export const errorResponse = (
  message: Record<string, unknown>,
  id: JsonRpcId,
  text: string,
): Record<string, unknown> => ({
  jsonrpc: jsonrpcOf(message),
  id,
  result: errorResult(message, text),
});

/**
 * An MCP proxy has no channel to a human, so a policy `ask` is rendered as a deny that
 * says so and names the rule to relax — lossy on the wire by design, never lossy in
 * the audit. One trailing period is stripped from the policy's own reason first:
 * every default `ask` reason is written without one, but a custom policy's is not
 * Stroq's to assume, and appending unconditionally would render `..`.
 */
const askAsDeny = (decision: Decision): string => {
  const reason = decision.reason.endsWith('.') ? decision.reason.slice(0, -1) : decision.reason;
  return (
    `Stroq would ask before this action (${decision.ruleId}): ${reason}. ` +
    'An MCP proxy cannot prompt, so it is denied; run it yourself or relax the rule in ~/.stroq/policy.yaml.'
  );
};

/** The whole text the model reads for a blocked call, evidence included. */
export function decisionText(
  decision: Decision,
  provenance: readonly ProvenanceHit[],
  secrets: readonly SecretHit[],
  now: Date = new Date(),
): string {
  const headline =
    decision.effect === 'deny'
      ? `Stroq blocked this action (${decision.ruleId}): ${decision.reason}`
      : askAsDeny(decision);
  return withEvidence(headline, provenance, now, secrets);
}

/** A `tools/call` Stroq could not classify at all; denied rather than forwarded. */
export const MCP_MALFORMED_CALL: Decision = {
  effect: 'deny',
  ruleId: 'mcp-proxy-malformed-call',
  reason:
    'The tools/call named no tool (params.name is missing or not a string), so Stroq could not classify it; denied fail-closed.',
};

/** The scan bound as the reason prints it: `2097152` characters is 2 MiB. */
const SCAN_BOUND_MIB = MAX_SCAN_CHARS / (1024 * 1024);

/**
 * A `tools/call` whose serialised arguments are larger than everything core's
 * secret-egress guard reads. That guard scans `JSON.stringify(toolInput)` in
 * overlapping windows up to `MAX_SCAN_CHARS` — bounding the INPUT rather than the
 * candidate list is what makes padding useless THERE — but a proxy that forwards
 * more than that anyway would move the padding attack one level up: filler past the
 * bound puts a `.env` value outside every window, and the call leaves with it. So a
 * call Stroq cannot scan whole is not forwarded at all. This is defence in depth —
 * the engine denies the same call as `secret.unscannable` — kept because refusing
 * here is cheaper and keeps a 2 MiB serialisation out of the audit summary. The
 * reason names the bound in MiB and nothing from the arguments themselves, which
 * are exactly where a secret is.
 */
export const MCP_ARGUMENTS_TOO_LARGE: Decision = {
  effect: 'deny',
  ruleId: 'mcp-proxy-arguments-too-large',
  reason:
    `The tools/call arguments serialise to more than ${SCAN_BOUND_MIB} MiB, everything Stroq's secret-egress guard scans, ` +
    'so a secret value padded past it would leave unseen; a call Stroq cannot scan whole is not forwarded. Denied fail-closed.',
};

/** A JSON-RPC batch carrying a `tools/call`; refused whole. */
export const MCP_BATCH_REFUSED: Decision = {
  effect: 'deny',
  ruleId: 'mcp-proxy-batch',
  reason:
    'A JSON-RPC batch containing a tools/call cannot be judged call by call; denied fail-closed. Batching was removed from the MCP protocol in 2025-06-18 — send one message per line.',
};

export const BATCH_ERROR_CODE = -32600;
export const BATCH_ERROR_MESSAGE =
  'Stroq refused this batch: it contains a tools/call. Send one message per line.';

/**
 * The shared audit path for the proxy's own denies. `denyDirectly` renders through a
 * `HookOutput`, so the JSON-RPC response rides in `stdout` as JSON and is parsed back
 * out here — the alternative, a second audit-append call site, is how a deny that
 * `stroq log`/`why` cannot explain gets shipped.
 */
async function auditedDeny(
  ctx: McpContext,
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: Decision,
  summary: string,
  message: Record<string, unknown>,
  id: JsonRpcId,
): Promise<Record<string, unknown>> {
  const event: EngineEvent = { sessionId: ctx.sessionId, toolName, toolInput, cwd: ctx.cwd };
  const out = await denyDirectly(event, decision, summary, (recorded) => ({
    stdout: JSON.stringify(errorResponse(message, id, decisionText(recorded, [], []))),
    exitCode: 0,
  }));
  return JSON.parse(out.stdout) as Record<string, unknown>;
}

/** What the proxy must do with the line it just judged. */
export interface JudgeVerdict {
  /** True when the ORIGINAL line is to be forwarded byte for byte. */
  readonly forward: boolean;
  /** The reply to write to the client instead; the caller serialises and terminates it. */
  readonly reply: Record<string, unknown> | null;
  /** Remembered so the response can be scanned; null when nothing was forwarded. */
  readonly pending: PendingRequest | null;
}

export async function judgeToolCall(
  ctx: McpContext,
  message: Record<string, unknown>,
  id: JsonRpcId,
  params: Record<string, unknown>,
): Promise<JudgeVerdict> {
  const rawName = params['name'];
  const toolInput = mcpCallInput(params);
  if (typeof rawName !== 'string' || rawName === '')
    return {
      forward: false,
      pending: null,
      reply: await auditedDeny(
        ctx,
        mcpToolName(ctx.server, ''),
        toolInput,
        MCP_MALFORMED_CALL,
        'mcp proxy: tools/call without a tool name',
        message,
        id,
      ),
    };
  const toolName = mcpToolName(ctx.server, rawName);
  // Before the engine, because the engine is what cannot see past this bound: core
  // scans `JSON.stringify(toolInput)` only to `MAX_SCAN_CHARS`, so anything longer
  // would be judged on a prefix of itself. The summary names the argument KEYS and
  // never their values — `describeToolInput` is the same keys-only reader the Codex
  // and Copilot unreadable-input denies audit with — so neither the padding nor a
  // secret hidden behind it reaches the audit log.
  const serialised = JSON.stringify(toolInput).length;
  if (serialised > MAX_SCAN_CHARS)
    return {
      forward: false,
      pending: null,
      reply: await auditedDeny(
        ctx,
        toolName,
        toolInput,
        MCP_ARGUMENTS_TOO_LARGE,
        `mcp proxy: tools/call arguments of ${serialised} characters, above the ${MAX_SCAN_CHARS} the secret guard scans (keys: ${describeToolInput(toolInput)})`,
        message,
        id,
      ),
    };
  const event: EngineEvent = { sessionId: ctx.sessionId, toolName, toolInput, cwd: ctx.cwd };
  const { decision, provenance, secrets } = await decidePre(ctx.engine, event, [toolInput]);
  if (decision.effect === 'allow')
    return { forward: true, reply: null, pending: { method: 'tools/call', toolName } };
  return {
    forward: false,
    pending: null,
    reply: errorResponse(message, id, decisionText(decision, provenance, secrets)),
  };
}

/**
 * True for a batch carrying any `tools/call`, with or without an id. An idless one
 * cannot be answered individually, but its presence still refuses the whole batch:
 * a call Stroq cannot address is a call Stroq cannot judge.
 */
export const batchHasToolCall = (items: readonly unknown[]): boolean =>
  items.some((item) => isRecord(item) && item['method'] === 'tools/call');

/**
 * One reply per addressable request in the batch, in the order the batch listed them:
 * an `isError` result for each `tools/call`, a `-32600` for every other request, and
 * nothing at all for a notification, as JSON-RPC requires. The caller writes the
 * array as one line and forwards none of the batch. Every `tools/call` is audited
 * through `denyDirectly` even when it has no id to answer: it is unanswerable, but
 * its presence is still why the whole batch was refused, and `stroq log` should be
 * able to explain that for every tools/call the batch carried, not just the ones a
 * reply could be sent for.
 */
export async function refuseBatch(
  ctx: McpContext,
  items: readonly unknown[],
): Promise<readonly unknown[]> {
  const replies: unknown[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item['method'] !== 'string') continue;
    const id = asJsonRpcId(item['id']);
    if (item['method'] !== 'tools/call') {
      // A notification never reached the engine, so there is nothing to audit either.
      if (id === null) continue;
      replies.push({
        jsonrpc: jsonrpcOf(item),
        id,
        error: { code: BATCH_ERROR_CODE, message: BATCH_ERROR_MESSAGE },
      });
      continue;
    }
    const params = paramsOf(item);
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const toolName = mcpToolName(ctx.server, name);
    const toolInput = mcpCallInput(params);
    const summary = 'mcp proxy: tools/call inside a JSON-RPC batch';
    if (id === null) {
      const event: EngineEvent = { sessionId: ctx.sessionId, toolName, toolInput, cwd: ctx.cwd };
      await denyDirectly(event, MCP_BATCH_REFUSED, summary, () => ({ stdout: '', exitCode: 0 }));
      continue;
    }
    replies.push(await auditedDeny(ctx, toolName, toolInput, MCP_BATCH_REFUSED, summary, item, id));
  }
  return replies;
}

/**
 * The shared `post` path: scan the result, record provenance, taint the session. The
 * `toolInput` carries only the method, never the arguments: the arguments were judged
 * and audited on the way in, and repeating them here would put a secret-shaped
 * argument in a second audit line. The method still rides along so the post audit
 * line's summary reads e.g. `{"method":"tools/list"}` rather than the unreadable
 * `{}`. Returns the warning text when the scan came back suspect, else null.
 */
export async function scanMcpResult(
  ctx: McpContext,
  pending: PendingRequest,
  result: unknown,
): Promise<string | null> {
  const event: EngineEvent = {
    sessionId: ctx.sessionId,
    toolName: pending.toolName,
    toolInput: { method: pending.method },
    cwd: ctx.cwd,
  };
  const outcome = await scanPostResult(ctx.engine, event, resultTextFor(pending.method, result));
  return outcome.warning;
}

/**
 * The one channel that reaches the model in MCP: an extra text item on the result's
 * own `content`. Nothing else is altered — `structuredContent`, `isError`,
 * `resultType` and every other key are carried through by the spread — and the
 * warning already opens with the warning sign, because core's `warningFor` writes it.
 * A non-array `content` (a malformed or legacy result) is not noise to discard: it is
 * kept as the first item, so the warning is appended rather than replacing data.
 */
export function withWarningBlock(
  result: Record<string, unknown>,
  warning: string,
): Record<string, unknown> {
  const existing = result['content'];
  const content = Array.isArray(existing) ? existing : existing === undefined ? [] : [existing];
  return { ...result, content: [...content, { type: 'text', text: warning }] };
}
