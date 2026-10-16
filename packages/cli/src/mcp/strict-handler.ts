import { isRecord } from '../adapters/tool-input.js';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { denyDirectly, scanPostResult, type PostOutcome } from '../adapters/pre-decision.js';
import { logError } from '../log.js';
import { cloakNotice, type McpCloak } from './cloak.js';
import {
  MAX_LINE_CHARS,
  asJsonRpcId,
  classifyMessage,
  isScannedMethod,
  parseLine,
  type JsonRpcId,
  type McpMessage,
  type SplitLine,
} from './framing.js';
import { withWarningBlock, type McpContext } from './judge.js';
import type { StrictLedger, TrackedRequest } from './strict-ledger.js';
import { STRICT_ID_SNIFF_CHARS } from './strict-limits.js';
import { describeMethod, mayForwardServerMessage } from './strict-messages.js';
import {
  refusedServerRequest,
  terminatedDecision,
  terminatedResponse,
  withheldDecision,
  withheldResponse,
  type WithholdReason,
} from './strict-reasons.js';
import { readStrictError, readStrictResult } from './strict-result.js';
import type { BoundedScanVerdict } from './strict-scan.js';

/**
 * The server-to-client half of `stroq mcp --strict`. Every server line comes through
 * here instead of `proxy-pump.ts`'s default handler, and leaves one of three ways:
 * delivered, after Stroq read and scanned all of it; withheld, with the client's request
 * answered by a fixed error if the message could be tied to one; or dropped because the
 * server was ended. Nothing is forwarded on the strength of "it parsed" or "it is
 * probably nothing": the default pump forwards what it could not parse, what answers no
 * request and what it threw on, and each of those is a withhold here.
 *
 * A delivered message is the JSON Stroq parsed, written again: what the client receives
 * is the structure that was scanned, so a duplicate key (which parsers disagree on)
 * cannot show the client a value other than the one that was read. The cost is that a
 * delivered strict message is no longer byte for byte what the server sent.
 */

export interface StrictHandlerDeps {
  readonly ctx: McpContext;
  readonly ledger: StrictLedger;
  readonly cloak: McpCloak | null;
  /** How many withheld messages end the server. */
  readonly maxWithheld: number;
  /** The scan under a hard deadline; see `strict-scan.ts`. */
  readonly scan: (text: string, toolName: string) => BoundedScanVerdict;
  /** One JSON message to the client, backpressure honoured. For the short fixed messages Stroq writes itself. */
  readonly toClient: (value: unknown) => Promise<void>;
  /** The same for a line the handler serialised itself, so a failure to serialise is its to handle. */
  readonly toClientLine: (line: string) => Promise<void>;
  /** One JSON message to the server; fire and forget, since there are at most `maxWithheld` of them. */
  readonly toServer: (value: unknown) => void;
  /** Ends the server process (and, after a grace period, kills it). */
  readonly terminate: () => void;
  /** A line for the proxy's own diagnostics (stderr). */
  readonly note: (text: string) => void;
}

export interface StrictServerHandler {
  readonly onServerLine: (line: SplitLine) => Promise<void>;
  /** True once the server was ended for exceeding its withheld-message limit. */
  readonly wasTerminated: () => boolean;
}

/** The id a response-shaped message that failed to parse seems to answer, when its head says. */
const ID_IN_HEAD = /"id"\s*:\s*(-?\d{1,15}|"[^"\\]{1,64}")/;

/** The request id named in the head of an unparsable or oversize line, or null. */
export function sniffId(head: string): JsonRpcId | null {
  const found = ID_IN_HEAD.exec(head.slice(0, STRICT_ID_SNIFF_CHARS))?.[1];
  if (found === undefined) return null;
  return asJsonRpcId(found.startsWith('"') ? found.slice(1, -1) : Number(found));
}

/** What an id looks like in an audit line without saying it: a server chose it. */
const describeId = (id: JsonRpcId): string =>
  typeof id === 'string' ? `string of ${id.length} characters` : 'number';

const RESPONSE_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'result', 'error']);

type ResponseMessage = Extract<McpMessage, { kind: 'response' }>;
type ServerInitiated = Extract<McpMessage, { kind: 'request' | 'notification' }>;

export function createStrictHandler(deps: StrictHandlerDeps): StrictServerHandler {
  const { ctx, ledger, cloak, maxWithheld } = deps;
  let withheldCount = 0;
  let terminated = false;
  let inOversizeRun = false;

  const toolOf = (what: string): string => mcpToolName(ctx.server, what);

  const audit = async (
    reason: WithholdReason,
    toolName: string,
    summary: string,
  ): Promise<void> => {
    try {
      await denyDirectly(
        { sessionId: ctx.sessionId, toolName, toolInput: {}, cwd: ctx.cwd },
        withheldDecision(reason),
        `mcp strict: ${summary}`,
        () => ({ stdout: '', exitCode: 0 }),
      );
    } catch (err) {
      // A request that cannot be audited must still be answered: the audit failing
      // is a thing to log, never a reason for the client to wait forever.
      logError('mcp strict audit', err);
    }
  };

  /** Ends the server: answers everything still waiting, says why on stderr, stops the process. */
  async function endServer(also: TrackedRequest | null): Promise<void> {
    terminated = true;
    const waiting = [...(also === null ? [] : [also]), ...ledger.drain()];
    try {
      await denyDirectly(
        {
          sessionId: ctx.sessionId,
          toolName: toolOf('strict_terminated'),
          toolInput: {},
          cwd: ctx.cwd,
        },
        terminatedDecision(maxWithheld),
        `mcp strict: the server had more than ${maxWithheld} messages withheld and was ended`,
        () => ({ stdout: '', exitCode: 0 }),
      );
    } catch (err) {
      logError('mcp strict audit', err);
    }
    deps.note(
      `stroq mcp: strict mode ended the server "${ctx.server}": more than ${maxWithheld} of its messages were withheld (see stroq log)\n`,
    );
    for (const request of waiting) await deps.toClient(terminatedResponse(request.id, maxWithheld));
    deps.terminate();
  }

  /**
   * One withheld message: counted, audited and, if it belongs to a request, answered.
   * The answer is written even when the audit fails and even for the message that
   * crosses the limit, so no addressable request is ever left waiting.
   */
  async function withhold(
    reason: WithholdReason,
    options: {
      readonly toolName: string;
      readonly summary: string;
      readonly answers?: TrackedRequest | null;
      readonly toServer?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (terminated) return;
    withheldCount += 1;
    const answers = options.answers ?? null;
    if (withheldCount > maxWithheld) return endServer(answers);
    await audit(reason, options.toolName, options.summary);
    if (options.toServer !== undefined) deps.toServer(options.toServer);
    if (answers !== null) await deps.toClient(withheldResponse(answers.id, reason));
  }

  /** A message with no request to answer, or whose head may name one that is still waiting. */
  function withholdUnaddressed(reason: WithholdReason, what: string, head: string): Promise<void> {
    const sniffed = sniffId(head);
    const request = sniffed === null ? null : (ledger.take(sniffed) ?? null);
    return withhold(reason, {
      toolName: request?.toolName ?? toolOf('unreadable_server_message'),
      summary: `withheld ${what}${request === null ? ' (no request to answer)' : ' (its request was answered)'}`,
      answers: request,
    });
  }

  async function onOversize(line: SplitLine): Promise<void> {
    const first = !inOversizeRun;
    inOversizeRun = line.eol !== '\n';
    if (!first) return;
    logError('mcp proxy', new Error(`server line above ${MAX_LINE_CHARS} characters withheld`));
    await withholdUnaddressed(
      'oversize',
      `a server line above ${MAX_LINE_CHARS} characters`,
      line.text,
    );
  }

  /** The error object with the scan's warning appended to its message. */
  const withErrorWarning = (error: Record<string, unknown>, warning: string) => ({
    ...error,
    message: `${String(error['message'])}\n\n${warning}`,
  });

  /** Runs the cloak on a tools/call result; returns the delivered result or why not. */
  async function cloaked(
    entry: TrackedRequest,
    result: Record<string, unknown>,
  ): Promise<{ readonly result: Record<string, unknown>; readonly notice: string | null } | null> {
    if (cloak === null) return { result, notice: null };
    const outcome = await cloak.cloakResult(result);
    if (outcome.kind === 'refused') return null;
    if (outcome.kind === 'unchanged' || !isRecord(outcome.result)) return { result, notice: null };
    await cloak.auditCloak(entry.toolName, outcome);
    return { result: outcome.result, notice: cloakNotice(outcome.replacements) };
  }

  /** Scans `text` and returns the engine's outcome, or the reason it cannot be delivered. */
  async function scanned(
    entry: TrackedRequest,
    text: string,
  ): Promise<PostOutcome | WithholdReason> {
    const verdict = deps.scan(text, entry.toolName);
    if (verdict !== 'ok') return verdict === 'timeout' ? 'scan-timeout' : 'scan-failed';
    try {
      const outcome = await scanPostResult(
        ctx.engine,
        {
          sessionId: ctx.sessionId,
          toolName: entry.toolName,
          toolInput: { method: entry.method },
          cwd: ctx.cwd,
        },
        text,
      );
      return outcome.timedOut === true ? 'scan-timeout' : outcome;
    } catch (err) {
      logError('mcp strict scan', err);
      return 'scan-failed';
    }
  }

  async function onResponse(message: ResponseMessage): Promise<void> {
    const { id, value } = message;
    const entry = ledger.take(id);
    if (entry === undefined) {
      if (ledger.takeCancelled(id)) return;
      const meant = ledger.mismatched(id);
      if (meant !== undefined) ledger.take(meant.id);
      return withhold(meant === undefined ? 'unknown-id' : 'id-mismatch', {
        toolName: meant?.toolName ?? toolOf('unknown_response_id'),
        summary: `withheld a response with ${meant === undefined ? 'an unknown or already answered' : 'a differently typed'} id (${describeId(id)})`,
        answers: meant ?? null,
      });
    }
    const about = { toolName: entry.toolName, answers: entry };
    const isError = Object.hasOwn(value, 'error');
    if (
      !Object.keys(value).every((key) => RESPONSE_KEYS.has(key)) ||
      (isError && 'result' in value)
    )
      return withhold('invalid-shape', {
        ...about,
        summary: `withheld a ${describeMethod(entry.method)} response of an unknown shape`,
      });
    const read = isError
      ? readStrictError(value['error'])
      : readStrictResult(entry.method, value['result']);
    if (!read.ok)
      return withhold(read.reason, {
        ...about,
        summary: `withheld a ${describeMethod(entry.method)} response`,
      });
    return deliver(entry, message, read.text);
  }

  async function deliver(
    entry: TrackedRequest,
    message: ResponseMessage,
    text: string,
  ): Promise<void> {
    const { value } = message;
    const about = { toolName: entry.toolName, answers: entry };
    const nothingToRead = text === '' && !isScannedMethod(entry.method);
    const outcome = nothingToRead ? null : await scanned(entry, text);
    if (typeof outcome === 'string')
      return withhold(outcome, {
        ...about,
        summary: `withheld a ${describeMethod(entry.method)} response`,
      });
    const warning = outcome?.warning ?? null;
    if (Object.hasOwn(value, 'error')) {
      const error = value['error'] as Record<string, unknown>;
      return send(entry, {
        ...value,
        error: warning === null ? error : withErrorWarning(error, warning),
      });
    }
    let result = value['result'];
    let notice: string | null = null;
    if (cloak !== null && entry.method === 'tools/call' && isRecord(result)) {
      const done = await cloaked(entry, result).catch((err: unknown) => {
        logError('mcp strict cloak', err);
        return null;
      });
      if (done === null)
        return withhold('cloak-refused', {
          ...about,
          summary: 'withheld a tools/call result the cloak refused',
        });
      result = done.result;
      notice = done.notice;
    }
    if (isRecord(result) && entry.method === 'tools/call') {
      if (warning !== null) result = withWarningBlock(result, warning);
      if (notice !== null) result = withWarningBlock(result as Record<string, unknown>, notice);
    }
    return send(entry, { ...value, result });
  }

  /**
   * Writes the message that answers `entry`. It is serialised here, ahead of the write,
   * because every part of it was serialised separately while it was read and a value
   * nested to just under the limit can pass each of those and still overflow once it is
   * wrapped in the envelope: that is a message Stroq could not finish reading, not a
   * request to leave waiting.
   */
  async function send(entry: TrackedRequest, message: Record<string, unknown>): Promise<void> {
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch (err) {
      logError('mcp strict serialise', err);
      return withhold('scan-failed', {
        toolName: entry.toolName,
        answers: entry,
        summary: `withheld a ${describeMethod(entry.method)} response that could not be written`,
      });
    }
    return deps.toClientLine(line);
  }

  async function onServerInitiated(message: ServerInitiated): Promise<void> {
    if (mayForwardServerMessage(message)) return deps.toClient(message.value);
    return withhold('unsolicited', {
      toolName: toolOf('unsolicited_server_message'),
      summary: `withheld a server ${message.kind} (${describeMethod(message.method)})`,
      ...(message.kind === 'request' ? { toServer: refusedServerRequest(message.id) } : {}),
    });
  }

  async function handle(line: SplitLine): Promise<void> {
    if (line.oversize) return onOversize(line);
    const value = parseLine(line.text);
    if (value === undefined)
      return withholdUnaddressed('unparsable', 'a server line that is not JSON', line.text);
    const message = classifyMessage(value);
    if (message.kind === 'response') return onResponse(message);
    if (message.kind === 'request' || message.kind === 'notification')
      return onServerInitiated(message);
    // A batch, or an object that is no kind of message: nothing to forward. A response
    // shape with an id Stroq can read may still name a request that is waiting.
    const named = isRecord(value) ? asJsonRpcId(value['id']) : null;
    const request = named === null ? null : (ledger.take(named) ?? null);
    return withhold('invalid-shape', {
      toolName: request?.toolName ?? toolOf('unreadable_server_message'),
      summary: `withheld a server ${message.kind === 'batch' ? 'batch' : 'message of an unknown kind'}`,
      answers: request,
    });
  }

  return {
    wasTerminated: () => terminated,
    onServerLine: async (line) => {
      if (terminated) return;
      await handle(line);
    },
  };
}
