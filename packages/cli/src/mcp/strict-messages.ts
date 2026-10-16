import { isRecord } from '../adapters/tool-input.js';
import type { McpMessage } from './framing.js';
import { STRICT_ID_CHARS } from './strict-limits.js';

/**
 * Which messages a SERVER starts, rather than answers, strict mode still forwards.
 *
 * A server-initiated message is not a result of anything the client asked for, so there
 * is no request to hold it to and, for most of them, text the model or the user may read
 * that nobody has scanned. The default is therefore to withhold, and the list below is
 * the exception, each entry carrying NO free text a server could put its own words in:
 *
 * - `notifications/tools/list_changed`, `.../resources/list_changed`,
 *   `.../prompts/list_changed`, with no parameters. They tell the client its cached list
 *   is stale; the client then asks again, and the answer comes back through the proxy
 *   and is scanned like any other. Dropping them would hide a legitimate tool change
 *   from the client. A rug-pull the notification announces is caught by the re-listing.
 * - `notifications/progress`, only when it is a token and numbers. Its `message` is free
 *   text, so a progress notification that has one is withheld; a server that reports
 *   progress in words loses those words under `--strict`, and that is stated, not
 *   hidden.
 * - `ping`, a request with no parameters. A liveness check the client answers on its own;
 *   without it some clients would close a connection they consider dead.
 *
 * Withheld, and why: `sampling/createMessage` (the server asking the client's model to
 * run a prompt it wrote), `elicitation/create` (the server asking the user a question in
 * its own words), `roots/list` (a server reading the client's directories),
 * `notifications/message` (log lines: free text, and the proper channel for a server's
 * logging is its stderr, which Stroq leaves alone), `notifications/resources/updated`
 * (it carries a server-chosen URI, and the proxy does not track subscriptions to tell a
 * real one from an invented one), `notifications/cancelled`, and anything not named
 * here, new methods included. When unsure, the message is withheld.
 */

const LIST_CHANGED = [
  'notifications/tools/list_changed',
  'notifications/resources/list_changed',
  'notifications/prompts/list_changed',
] as const;
const PROGRESS = 'notifications/progress';
const PING = 'ping';
const JSONRPC_VERSION = '2.0';

/** Every method strict mode forwards when a server starts the exchange. */
export const FORWARDED_SERVER_METHODS: readonly string[] = [...LIST_CHANGED, PROGRESS, PING];

const JSON_RPC_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params']);
const PROGRESS_KEYS: ReadonlySet<string> = new Set(['progressToken', 'progress', 'total']);

/** An id or a progress token a client could have chosen: short, and no word a person would read. */
const TOKEN = new RegExp(`^[A-Za-z0-9._:-]{1,${STRICT_ID_CHARS}}$`);

const isEmptyParams = (params: unknown): boolean =>
  params === undefined || (isRecord(params) && Object.keys(params).length === 0);

const isToken = (value: unknown): value is string | number =>
  Number.isSafeInteger(value) || (typeof value === 'string' && TOKEN.test(value));

/** The three fields of a plain progress notification, or null when it is anything more. */
function plainProgress(params: unknown): Record<string, unknown> | null {
  if (!isRecord(params) || !Object.keys(params).every((key) => PROGRESS_KEYS.has(key))) return null;
  const { progressToken, progress, total } = params;
  if (!isToken(progressToken) || typeof progress !== 'number' || !Number.isFinite(progress))
    return null;
  if (total !== undefined && !(typeof total === 'number' && Number.isFinite(total))) return null;
  return { progressToken, progress, ...(total === undefined ? {} : { total }) };
}

/**
 * The message strict mode forwards for a server-initiated `message`, or null to withhold
 * it. The message is BUILT here from the fields that were checked, not passed on: the
 * server's own `jsonrpc` member and any string it put in an id would otherwise reach the
 * client as they came.
 */
export function forwardableServerMessage(
  message: Extract<McpMessage, { kind: 'request' | 'notification' }>,
): Record<string, unknown> | null {
  const { value, method } = message;
  if (!Object.keys(value).every((key) => JSON_RPC_KEYS.has(key))) return null;
  if (message.kind === 'request') {
    if (method !== PING || !isEmptyParams(value['params']) || !isToken(message.id)) return null;
    return { jsonrpc: JSONRPC_VERSION, id: message.id, method };
  }
  if ((LIST_CHANGED as readonly string[]).includes(method))
    return isEmptyParams(value['params']) ? { jsonrpc: JSONRPC_VERSION, method } : null;
  if (method !== PROGRESS) return null;
  const params = plainProgress(value['params']);
  return params === null ? null : { jsonrpc: JSONRPC_VERSION, method, params };
}

/**
 * A method name as an audit line may show it. The method is chosen by the server, so it
 * is repeated only when it is short and made of the characters a method name has; any
 * other string could be the server writing into the log.
 */
export const describeMethod = (method: string): string =>
  /^[A-Za-z0-9_./-]{1,64}$/.test(method) ? method : '(unprintable method)';
