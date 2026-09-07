import type { Decision, ProvenanceHit, SecretHit, StroqEngine } from '@stroq/core';
import { withEvidence } from '../adapters/claude-code.js';
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
 * `JSON.stringify(toolInput)`, so a field dropped here is a value that can never be
 * caught leaving through this call. A modern retry's `inputResponses` ride along
 * under their own key so the retry is judged on what it actually carries.
 */
export function mcpCallInput(params: Record<string, unknown>): Record<string, unknown> {
  const record = toolInputRecord(params['arguments']);
  const responses = params['inputResponses'];
  return responses === undefined ? record : { ...record, inputResponses: responses };
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
 * array as one line and forwards none of the batch.
 */
export async function refuseBatch(
  ctx: McpContext,
  items: readonly unknown[],
): Promise<readonly unknown[]> {
  const replies: unknown[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item['method'] !== 'string') continue;
    const id = asJsonRpcId(item['id']);
    if (id === null) continue;
    if (item['method'] !== 'tools/call') {
      replies.push({
        jsonrpc: jsonrpcOf(item),
        id,
        error: { code: BATCH_ERROR_CODE, message: BATCH_ERROR_MESSAGE },
      });
      continue;
    }
    const params = paramsOf(item);
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    replies.push(
      await auditedDeny(
        ctx,
        mcpToolName(ctx.server, name),
        mcpCallInput(params),
        MCP_BATCH_REFUSED,
        'mcp proxy: tools/call inside a JSON-RPC batch',
        item,
        id,
      ),
    );
  }
  return replies;
}

/** The same bound `toolResultToText` clips a tool result to in the Claude Code adapter. */
export const MCP_MAX_RESULT_CHARS = 200_000;

const clip = (text: string): string => text.slice(0, MCP_MAX_RESULT_CHARS);

const stringAt = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

const asJson = (value: unknown): string => JSON.stringify(value) ?? '';

/**
 * Every string in one content item the model would read. A text item gives its text;
 * a `resource_link` gives its `uri`, `name` and `description`; an embedded `resource`
 * gives its own `text`, or its `uri` when the body is a blob. `image` and `audio`
 * items carry base64 `data` and a mime type and contribute nothing — there is no
 * instruction text in a JPEG's bytes, and scanning megabytes of base64 on every call
 * is the kind of cost that gets a proxy uninstalled.
 */
function contentItemText(item: unknown): string {
  if (!isRecord(item)) return '';
  const direct = stringAt(item, 'text');
  if (direct !== '') return direct;
  const parts = [stringAt(item, 'uri'), stringAt(item, 'name'), stringAt(item, 'description')];
  const resource = item['resource'];
  if (isRecord(resource)) {
    const body = stringAt(resource, 'text');
    parts.push(body !== '' ? body : stringAt(resource, 'uri'));
  }
  return parts.filter((part) => part !== '').join(' ');
}

/** One item or an array of them, joined a line each. */
const itemsText = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .map(contentItemText)
        .filter((text) => text !== '')
        .join('\n')
    : contentItemText(value);

const joined = (parts: readonly string[]): string =>
  clip(parts.filter((part) => part !== '').join('\n'));

/**
 * A `tools/call` result: every content item, `structuredContent` as JSON, and an
 * `input_required` reply's `inputRequests` — the modern shape by which a server asks
 * the model for more input, which is exactly where an injection would sit. `isError`
 * results are scanned too: a poisoned error text is still content the model reads.
 */
export function mcpResultText(result: unknown): string {
  if (!isRecord(result)) return '';
  const structured = result['structuredContent'];
  const inputRequests = result['inputRequests'];
  return joined([
    itemsText(result['content']),
    structured === undefined ? '' : asJson(structured),
    inputRequests === undefined ? '' : asJson(inputRequests),
  ]);
}

/** A `tools/list` result: the name, title, description and annotations of every tool. */
function toolsListText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result['tools'])) return '';
  return joined(
    result['tools'].map((tool) => {
      if (!isRecord(tool)) return '';
      const annotations = tool['annotations'];
      return [
        stringAt(tool, 'name'),
        stringAt(tool, 'title'),
        stringAt(tool, 'description'),
        annotations === undefined ? '' : asJson(annotations),
      ]
        .filter((part) => part !== '')
        .join(' ');
    }),
  );
}

/** A `resources/read` result: the text of every entry it returned. */
function resourcesReadText(result: unknown): string {
  if (!isRecord(result)) return '';
  return joined([itemsText(result['contents'])]);
}

/** A `prompts/get` result: its description and the text of every message. */
function promptsGetText(result: unknown): string {
  if (!isRecord(result)) return '';
  const messages = Array.isArray(result['messages']) ? result['messages'] : [];
  return joined([
    stringAt(result, 'description'),
    ...messages.map((message) => (isRecord(message) ? itemsText(message['content']) : '')),
  ]);
}

export function resultTextFor(method: ScannedMethod, result: unknown): string {
  if (method === 'tools/list') return toolsListText(result);
  if (method === 'resources/read') return resourcesReadText(result);
  if (method === 'prompts/get') return promptsGetText(result);
  return mcpResultText(result);
}

/**
 * The shared `post` path: scan the result, record provenance, taint the session. The
 * `toolInput` is `{}` on purpose — the arguments were judged and audited on the way
 * in, and repeating them here would put a secret-shaped argument in a second audit
 * line. Returns the warning text when the scan came back suspect, else null.
 */
export async function scanMcpResult(
  ctx: McpContext,
  pending: PendingRequest,
  result: unknown,
): Promise<string | null> {
  const event: EngineEvent = {
    sessionId: ctx.sessionId,
    toolName: pending.toolName,
    toolInput: {},
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
 */
export function withWarningBlock(
  result: Record<string, unknown>,
  warning: string,
): Record<string, unknown> {
  const content = Array.isArray(result['content']) ? result['content'] : [];
  return { ...result, content: [...content, { type: 'text', text: warning }] };
}
