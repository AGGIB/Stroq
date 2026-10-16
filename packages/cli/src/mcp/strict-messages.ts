import { isRecord } from '../adapters/tool-input.js';
import type { McpMessage } from './framing.js';

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

/** Every method strict mode forwards when a server starts the exchange. */
export const FORWARDED_SERVER_METHODS: readonly string[] = [...LIST_CHANGED, PROGRESS, PING];

const JSON_RPC_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params']);
const PROGRESS_KEYS: ReadonlySet<string> = new Set(['progressToken', 'progress', 'total']);

/** A progress token a client could have sent: short, and made of no word a person would read. */
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/;

const isEmptyParams = (params: unknown): boolean =>
  params === undefined || (isRecord(params) && Object.keys(params).length === 0);

function isPlainProgress(params: unknown): boolean {
  if (!isRecord(params) || !Object.keys(params).every((key) => PROGRESS_KEYS.has(key)))
    return false;
  const token = params['progressToken'];
  const tokenOk = typeof token === 'number' || (typeof token === 'string' && TOKEN.test(token));
  const numeric = (value: unknown): boolean => value === undefined || Number.isFinite(value);
  return tokenOk && Number.isFinite(params['progress']) && numeric(params['total']);
}

/** True when strict mode forwards this server-initiated message; false to withhold it. */
export function mayForwardServerMessage(
  message: Extract<McpMessage, { kind: 'request' | 'notification' }>,
): boolean {
  const { value, method } = message;
  if (!Object.keys(value).every((key) => JSON_RPC_KEYS.has(key))) return false;
  if (message.kind === 'request') return method === PING && isEmptyParams(value['params']);
  if ((LIST_CHANGED as readonly string[]).includes(method)) return isEmptyParams(value['params']);
  return method === PROGRESS && isPlainProgress(value['params']);
}

/**
 * A method name as an audit line may show it. The method is chosen by the server, so it
 * is repeated only when it is short and made of the characters a method name has; any
 * other string could be the server writing into the log.
 */
export const describeMethod = (method: string): string =>
  /^[A-Za-z0-9_./-]{1,64}$/.test(method) ? method : '(unprintable method)';
