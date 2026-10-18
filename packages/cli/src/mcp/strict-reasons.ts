import type { Decision } from '@stroq/core';
import { MAX_LINE_CHARS, type JsonRpcId } from './framing.js';
import { STRICT_ERROR_CODE, STRICT_ID_CHARS, STRICT_MAX_TEXT_CHARS } from './strict-limits.js';

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

const MIB = 1024 * 1024;

const EXPLANATION: Readonly<Record<WithholdReason, string>> = {
  oversize: `the message is larger than the proxy reads (${MAX_LINE_CHARS / MIB} MiB)`,
  unparsable: 'the message is not valid JSON',
  'invalid-shape': 'the message does not have the shape of an MCP message of that kind',
  'unread-content': 'the message carries content Stroq does not read',
  'oversize-text': `the message carries more text than Stroq scans (${STRICT_MAX_TEXT_CHARS.toLocaleString('en-US')} characters)`,
  'scan-failed': 'Stroq could not finish reading the message',
  'scan-timeout': 'scanning the message took longer than the time Stroq allows',
  'id-mismatch': 'the message answers with a request id of a different type than the request',
  'unknown-id': 'the message answers no request that is waiting for an answer',
  unsolicited: 'the server sent a message nobody asked for',
  'cloak-refused': 'the cloak could not process the message, so it was not delivered unmasked',
};

/**
 * Which cap a withheld message counts toward. A malformed or hostile message (not JSON, a
 * shape nobody defined, an answer to nothing, an unrecognised field, a request of the
 * client's model) is `hostile`. What a benign server also produces is `benign`: log lines
 * and progress messages (the one kind of server-initiated message that is often just
 * chatty), a scan that took too long, a text past the window, a result the cloak could not
 * mask. The two have separate caps; see `strict-limits.ts`.
 */
export type CountClass = 'hostile' | 'benign';

const BENIGN_REASONS: ReadonlySet<WithholdReason> = new Set([
  'scan-timeout',
  'oversize-text',
  'cloak-refused',
]);
const BENIGN_UNSOLICITED: ReadonlySet<string> = new Set([
  'notifications/message',
  'notifications/progress',
]);

/**
 * `method` is the method of a message the server started and `hasId` says whether that
 * message has an `id` member at all, usable or not. A log line or a progress message is
 * chatty only as a NOTIFICATION: one with an id is a request, the server asking the
 * client for something under the name of a harmless method, and it counts as hostile.
 */
export function countClass(reason: WithholdReason, method?: string, hasId = false): CountClass {
  if (BENIGN_REASONS.has(reason)) return 'benign';
  if (reason === 'unsolicited' && !hasId && method !== undefined && BENIGN_UNSOLICITED.has(method))
    return 'benign';
  return 'hostile';
}

/**
 * What the default proxy would have done with the message, so the client can tell what
 * strict mode changed. It forwards almost everything it cannot read; `--cloak` alone is
 * the exception, which DROPS a result it cannot mask and leaves the request unanswered.
 */
const WITHOUT_STRICT: Readonly<Partial<Record<WithholdReason, string>>> = {
  'cloak-refused':
    'Without --strict, --cloak alone would have dropped it and left the request unanswered.',
};
const WITHOUT_STRICT_DEFAULT = 'Without --strict the default proxy would have forwarded it.';

/** The sentence the client reads when its request was withheld. Fixed per reason. */
export const withheldMessage = (reason: WithholdReason): string =>
  `Stroq strict mode withheld this server response (${reason}): ${EXPLANATION[reason]}. ` +
  `Nothing the server sent for this request was delivered. ${WITHOUT_STRICT[reason] ?? WITHOUT_STRICT_DEFAULT}`;

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

/** JSON-RPC's own code for a method the receiver does not have. */
export const METHOD_NOT_FOUND_CODE = -32601;

/**
 * What the server is told when it sent a request strict mode will not deliver: a
 * method-not-found, so a server waiting on the client's answer fails that call at once
 * instead of waiting for one that will never be sent.
 *
 * The id is the server's, and is echoed only when it is short enough to be one: a refusal
 * is written to the server's stdin without waiting for it to drain, so what it carries
 * has to be bounded, and an id of any size the server chose is not. A longer one is
 * answered with `null`, which JSON-RPC allows when the id cannot be determined. The
 * number of refusals is bounded by the withheld-message caps, so the most that can ever
 * be buffered for the server is those caps times this small message.
 */
export const refusedServerRequest = (id: JsonRpcId): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: typeof id === 'string' && id.length > STRICT_ID_CHARS ? null : id,
  error: {
    code: METHOD_NOT_FOUND_CODE,
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

/** The audit decision for a forwarded server-initiated message. */
export const forwardedDecision = (method: string): Decision => ({
  effect: 'allow',
  ruleId: 'mcp-strict-forwarded',
  reason: `Strict mode verified and forwarded a server-initiated message (${method}).`,
});
