import type { Decision } from '@stroq/core';
import type { JsonRpcId } from './framing.js';
import { STRICT_ERROR_CODE } from './strict-limits.js';

/**
 * Why strict mode withheld a server message. Each class has ONE fixed sentence, used
 * for the client's error and the audit alike, and none of them ever carries a byte the
 * server sent: a hostile server controls every string in the message it is withheld
 * for, including its method and its id, so a reason that quoted any of it would hand
 * the server a way to write into the model's context through the very error that
 * refuses it.
 */
export const WITHHOLD_REASONS = [
  'oversize',
  'unparsable',
  'invalid-shape',
  'unread-content',
  'oversize-text',
  'scan-failed',
  'scan-timeout',
  'id-mismatch',
  'unknown-id',
  'unsolicited',
  'cloak-refused',
] as const;

export type WithholdReason = (typeof WITHHOLD_REASONS)[number];

const EXPLANATION: Readonly<Record<WithholdReason, string>> = {
  oversize: 'the message is larger than the proxy reads (8 MiB)',
  unparsable: 'the message is not valid JSON',
  'invalid-shape': 'the message does not have the shape of an MCP message of that kind',
  'unread-content': 'the message carries content Stroq does not read',
  'oversize-text': 'the message carries more text than Stroq scans (200,000 characters)',
  'scan-failed': 'Stroq could not finish reading the message',
  'scan-timeout': 'scanning the message took longer than the time Stroq allows',
  'id-mismatch': 'the message answers with a request id of a different type than the request',
  'unknown-id': 'the message answers no request that is waiting for an answer',
  unsolicited: 'the server sent a message nobody asked for',
  'cloak-refused': 'the cloak could not process the message, so it was not delivered unmasked',
};

/** The sentence the client reads when its request was withheld. Fixed per reason. */
export const withheldMessage = (reason: WithholdReason): string =>
  `Stroq strict mode withheld this server response (${reason}): ${EXPLANATION[reason]}. ` +
  'Nothing the server sent for this request was delivered. Without --strict it would have been forwarded unscanned.';

/** The JSON-RPC error answering request `id`, for a response strict mode withheld. */
export const withheldResponse = (
  id: JsonRpcId,
  reason: WithholdReason,
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: { code: STRICT_ERROR_CODE, message: withheldMessage(reason) },
});

/** The JSON-RPC error answering a request still waiting when strict mode ended the server. */
export const terminatedResponse = (id: JsonRpcId, limit: number): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: STRICT_ERROR_CODE,
    message: `Stroq strict mode ended this server after more than ${limit} withheld messages. No further answer will come.`,
  },
});

/**
 * What the server is told when it sent a request strict mode will not deliver: a
 * method-not-found, so a server waiting on the client's answer fails that call at once
 * instead of waiting for one that will never be sent.
 */
export const refusedServerRequest = (id: JsonRpcId): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32601,
    message: 'Stroq strict mode does not forward server-initiated requests to the client.',
  },
});

/** The audit decision for one withheld message: a deny, in the same shape every other proxy deny has. */
export const withheldDecision = (reason: WithholdReason): Decision => ({
  effect: 'deny',
  ruleId: `mcp-strict-${reason}`,
  reason: `Strict mode withheld a server message (${EXPLANATION[reason]}); the client was not given its content.`,
});

/** The audit decision for ending the server after too many withheld messages. */
export const terminatedDecision = (limit: number): Decision => ({
  effect: 'deny',
  ruleId: 'mcp-strict-terminated',
  reason: `The server had more than ${limit} messages withheld in one run, so strict mode ended it.`,
});
