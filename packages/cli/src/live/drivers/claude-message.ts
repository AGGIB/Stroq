// What one line of the stream of `claude -p --output-format stream-json` says, as the check reads it.
//
// Pure: a line that has been parsed goes in, and the events it makes, the facts it states and the reason to
// stop the host (if there is one) come out. The shapes are the ones measured on a real host (2026-10-12,
// `test/fixtures/hosts/claude-code/README.md`): an `init` message first, a `rate_limit_event` after it, then
// `assistant` messages whose content holds `thinking`, `tool_use` and `text` blocks, `user` messages that hold
// the `tool_result` of each call, and a `result` last.
//
// Reading is strict where a call could hide. A line of a kind this module knows, in a shape it does not, is
// "unreadable" (the caller counts it, and a stream with any is not trusted); a message of a kind it does not
// know is of no use to the check and is passed over, because new kinds of message are what a new version adds.
import { plainText } from '../plain-text.js';
import { isSubscriptionKeySource } from '../run-problem.js';
import type { StreamEvent } from '../types.js';

/** The most of a tool result or a reply that is kept: the words that matter are at its start. */
export const MAX_EVENT_TEXT_CHARS = 4096;
/** A word of the host's own that goes into a line a person reads. */
const MAX_SIGNAL_CHARS = 40;
const MAX_LIMIT_TEXT_CHARS = 160;

/** Why the host is to be stopped now, before it spends more. */
export type StreamStop =
  | { readonly kind: 'api-key'; readonly detail: string }
  | { readonly kind: 'limit'; readonly detail: string }
  | { readonly kind: 'too-much-output'; readonly detail: string };

/** What a stream states about the run, apart from what the model did. */
export interface StreamFacts {
  /** From the `init` message: how the host is paid for (a login, or a key). */
  readonly apiKeySource?: string;
  /** From the `init` message: where the host says it ran. */
  readonly cwd?: string;
  /** From the `result` message: the provider all the models of the run were billed through. */
  readonly apiProvider?: string;
  /** From a `rate_limit_event`: the host's own signal that the plan ran out or moved on to paid usage. */
  readonly limitHit?: string;
}

export interface Interpreted {
  readonly events: readonly StreamEvent[];
  readonly facts: StreamFacts;
  /** The line is of a kind the check reads, in a shape it cannot read. */
  readonly unreadable: boolean;
  readonly stop: StreamStop | null;
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cap = (text: string): string =>
  text.length > MAX_EVENT_TEXT_CHARS ? text.slice(0, MAX_EVENT_TEXT_CHARS) : text;

const nothing = (): Interpreted => ({ events: [], facts: {}, unreadable: false, stop: null });
const unreadable = (): Interpreted => ({ events: [], facts: {}, unreadable: true, stop: null });

/** A value the host chose, as a short plain token for a message. */
const shown = (value: unknown): string =>
  typeof value === 'string' ? plainText(value, MAX_SIGNAL_CHARS) : '?';

// ---------------------------------------------------------------------------------------------
// init: how the host is paid for, and where it runs.

function interpretInit(message: Obj): Interpreted {
  const source = typeof message['apiKeySource'] === 'string' ? message['apiKeySource'] : undefined;
  const cwd = typeof message['cwd'] === 'string' ? message['cwd'] : undefined;
  const facts: StreamFacts = {
    ...(source === undefined ? {} : { apiKeySource: source }),
    ...(cwd === undefined ? {} : { cwd }),
  };
  // A key source that is not a login is an API key, which bills an account that was not set aside for
  // this; one that is not stated cannot be told from one. Either way the host is stopped before it answers.
  const stop: StreamStop | null =
    source !== undefined && isSubscriptionKeySource(source)
      ? null
      : {
          kind: 'api-key',
          detail:
            source === undefined
              ? 'the host did not say how it is paid for, and an API key could be what pays'
              : `the host says its key source is "${shown(source)}", which is not a subscription login (an API key bills another account)`,
        };
  return { events: [{ type: 'init' }], facts, unreadable: false, stop };
}

// ---------------------------------------------------------------------------------------------
// rate_limit_event: the plan running out, or moving on to what is paid for.

/** What the host calls a plan that can still be used. */
const PLAN_STATUSES_THAT_GO_ON: ReadonlySet<string> = new Set(['allowed', 'allowed_warning']);

const limitStop = (limitHit: string): Interpreted => ({
  events: [],
  facts: { limitHit: plainText(limitHit, MAX_LIMIT_TEXT_CHARS) },
  unreadable: false,
  stop: { kind: 'limit', detail: plainText(limitHit, MAX_LIMIT_TEXT_CHARS) },
});

function interpretRateLimit(message: Obj): Interpreted {
  const info = message['rate_limit_info'];
  if (!isObject(info)) return nothing();
  // Extra usage is paid for out of an account the owner did not set aside for this check.
  if (info['isUsingOverage'] === true)
    return limitStop(
      `extra usage (overage) is in use: isUsingOverage true, overageStatus ${shown(info['overageStatus'])}`,
    );
  const status = info['status'];
  if (typeof status !== 'string' || PLAN_STATUSES_THAT_GO_ON.has(status.trim().toLowerCase()))
    return nothing();
  return limitStop(`plan status ${shown(status)}, limit type ${shown(info['rateLimitType'])}`);
}

// ---------------------------------------------------------------------------------------------
// assistant and user: the model's calls and what came back.

/** The kinds of block that are a call of a tool, by the host's own tools or another's. */
const CALL_BLOCKS: ReadonlySet<string> = new Set(['tool_use', 'server_tool_use', 'mcp_tool_use']);
/** The kinds of block of an assistant message that make no event and hide no call. */
const QUIET_BLOCKS: ReadonlySet<string> = new Set(['thinking', 'redacted_thinking']);

function callEvent(block: Obj): StreamEvent {
  return {
    type: 'tool_use',
    ...(typeof block['name'] === 'string' ? { name: block['name'] } : {}),
    input: block['input'],
  };
}

function interpretAssistant(message: Obj): Interpreted {
  const body = message['message'];
  const content = isObject(body) ? body['content'] : undefined;
  if (!Array.isArray(content)) return unreadable();
  const events: StreamEvent[] = [];
  for (const block of content as unknown[]) {
    if (!isObject(block) || typeof block['type'] !== 'string') return unreadable();
    const kind = block['type'];
    if (CALL_BLOCKS.has(kind)) events.push(callEvent(block));
    else if (kind === 'text' && typeof block['text'] === 'string')
      events.push({ type: 'text', text: cap(block['text']) });
    // Any other kind could be a call this module does not know: the line is not read as clean.
    else if (!QUIET_BLOCKS.has(kind)) return unreadable();
  }
  return { events, facts: {}, unreadable: false, stop: null };
}

/** The words of a tool result: a string, or the text blocks of a list. */
function wordsOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as unknown[])
    .flatMap((block) =>
      isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string'
        ? [block['text']]
        : [],
    )
    .join('\n');
}

function interpretUser(message: Obj): Interpreted {
  const body = message['message'];
  const content = isObject(body) ? body['content'] : undefined;
  if (typeof content === 'string') return nothing();
  if (!Array.isArray(content)) return unreadable();
  const events: StreamEvent[] = [];
  for (const block of content as unknown[]) {
    if (!isObject(block)) return unreadable();
    if (block['type'] === 'tool_result')
      events.push({
        type: 'tool_result',
        isError: block['is_error'] === true,
        text: cap(wordsOf(block['content'])),
      });
  }
  return { events, facts: {}, unreadable: false, stop: null };
}

// ---------------------------------------------------------------------------------------------
// result: how it ended, and through whom it was billed.

/**
 * The provider every model of the run was billed through. The `init` message does not say; the `result`
 * message names it per model. They must all say, and say the same: a model that does not, or two that
 * disagree, is not "the first party", and the second case is written so that it cannot read as it.
 */
export function providerOf(modelUsage: unknown): string | undefined {
  if (!isObject(modelUsage)) return undefined;
  const providers = Object.values(modelUsage).map((usage) =>
    isObject(usage) && typeof usage['provider'] === 'string' ? usage['provider'] : null,
  );
  if (providers.length === 0 || providers.some((provider) => provider === null)) return undefined;
  const distinct = [...new Set(providers as string[])];
  const only = distinct[0];
  return distinct.length === 1 && only !== undefined
    ? only
    : plainText(`mixed: ${distinct.join(', ')}`, MAX_LIMIT_TEXT_CHARS);
}

function interpretResult(message: Obj): Interpreted {
  const subtype = typeof message['subtype'] === 'string' ? message['subtype'] : undefined;
  const isError = message['is_error'] === true || (subtype !== undefined && subtype !== 'success');
  const words = typeof message['result'] === 'string' ? message['result'] : (subtype ?? '');
  const provider = providerOf(message['modelUsage']);
  return {
    events: [{ type: 'result', isError, text: cap(words) }],
    facts: provider === undefined ? {} : { apiProvider: provider },
    unreadable: false,
    stop: null,
  };
}

/** What one parsed line says. A line that is not an object does not get here. */
export function interpretMessage(message: Obj): Interpreted {
  switch (message['type']) {
    case 'system':
      return message['subtype'] === 'init' ? interpretInit(message) : nothing();
    case 'rate_limit_event':
      return interpretRateLimit(message);
    case 'assistant':
      return interpretAssistant(message);
    case 'user':
      return interpretUser(message);
    case 'result':
      return interpretResult(message);
    default:
      return nothing();
  }
}
