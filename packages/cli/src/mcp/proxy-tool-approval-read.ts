import { findLossyJson } from '../harden/json-lossy.js';
import { jsonTokens } from '../harden/json-tokens.js';
import type { JsonRpcId } from './framing.js';

/**
 * How `--tool-approval` reads a message that is not a tool listing.
 *
 * A listing becomes stored authority, so it is held to the tool-contract rules (`tool-contract-
 * canonical.ts`): no keys named after the object model, bounded size and nesting, no replacement
 * characters. None of that is about a CALL or a RESULT, which are ordinary JSON: an argument named
 * `constructor`, a big array, a long string. What a message must be is readable the same way by
 * Stroq and by the other side, and nothing more:
 *
 * - no key twice in one object (`JSON.parse` keeps the last, another parser may keep the first);
 * - every number exactly what was written (an integer beyond 2^53, too many digits, past the range
 *   of a double, or a negative zero is a different number once parsed, and Stroq would judge or
 *   deliver a value nobody sent).
 *
 * Keys are compared in a `Set`, never looked up on an object, so `__proto__` and `constructor` are
 * keys like any other. A message that fails is refused on its own; what that costs the session is
 * decided by the caller (`proxy-tool-approval.ts`), not here.
 */

export type MessageProblem = 'unreadable' | 'ambiguous' | 'inexact' | 'unsupported' | 'unpaired';

export interface MessageRead {
  /** What `JSON.parse` made of the text; `undefined` when it is not JSON. */
  readonly value: unknown;
  readonly problem: MessageProblem | null;
}

/** Integers within 2^53 print back as written; anything else is checked digit by digit. */
const exactNumber = (text: string): boolean => {
  const value = Number(text);
  return (Number.isSafeInteger(value) && String(value) === text) || findLossyJson(text) === null;
};

export function readApprovalMessage(raw: string): MessageRead {
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { value: undefined, problem: 'unreadable' };
  }
  const keys: (Set<string> | null)[] = [];
  let inexact = false;
  for (const token of jsonTokens(text)) {
    if (token.kind === 'open') keys.push(token.object ? new Set() : null);
    else if (token.kind === 'close') keys.pop();
    else if (token.kind === 'key') {
      const seen = keys[keys.length - 1];
      if (!seen || seen.has(token.value)) return { value, problem: 'ambiguous' };
      seen.add(token.value);
    } else if (token.kind === 'number' && !inexact) inexact = !exactNumber(token.text);
  }
  return { value, problem: inexact ? 'inexact' : null };
}

/** Fixed text: a refusal never repeats a byte of the message it refuses. */
const REFUSALS: Readonly<Record<MessageProblem, string>> = {
  unreadable: 'it is not JSON, or is longer than the line Stroq reads',
  ambiguous:
    'an object in it repeats a key, so Stroq and the MCP server could read different values. Send each key once',
  inexact:
    'it carries a number that cannot be represented exactly (an integer beyond 2^53, more digits than a double holds, or out of its range), so Stroq cannot judge the value the MCP server would receive. Send such a number as a string',
  unsupported: 'it is not a single JSON-RPC 2.0 request of a shape Stroq reads under tool approval',
  unpaired:
    'its id cannot be paired with exactly one answer (a request with that id is still open or was cancelled, the id is not a whole number within 2^53 or a string, or too many requests are open). Use a new id',
};

/**
 * The answer to one client request refused for what it is, not for what it asks. An id that is
 * itself not exact is answered as `null`, because echoing the rounded one would answer a request
 * nobody sent.
 */
export const messageRefusal = (
  problem: MessageProblem,
  id: JsonRpcId,
): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: typeof id === 'number' && !Number.isSafeInteger(id) ? null : id,
  error: {
    code: -32001,
    message: `Stroq withheld this request: ${REFUSALS[problem]}. Tool approvals are unchanged.`,
  },
});
