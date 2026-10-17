import { createPostReadings, type PostReadings } from '@stroq/core';
import { isRecord } from '../adapters/tool-input.js';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import {
  denyDirectly,
  scanPostResult,
  type PostOutcome,
  type PostReading,
} from '../adapters/pre-decision.js';
import { logError } from '../log.js';
import { cloakNotice, type McpCloak } from './cloak.js';
import {
  MAX_LINE_CHARS,
  asJsonRpcId,
  classifyMessage,
  parseLine,
  type JsonRpcId,
  type McpMessage,
  type SplitLine,
} from './framing.js';
import { appendBlocks, type McpContext } from './judge.js';
import type { StrictLedger, TrackedRequest } from './strict-ledger.js';
import { STRICT_MAX_BENIGN_WITHHELD } from './strict-limits.js';
import { strictLine } from './strict-line.js';
import { describeMethod, forwardableServerMessage } from './strict-messages.js';
import {
  countClass,
  refusedServerRequest,
  terminatedDecision,
  terminatedResponse,
  withheldDecision,
  withheldResponse,
  type WithholdReason,
} from './strict-reasons.js';
import { isCovered } from './strict-leaves.js';
import { readStrictError, readStrictResult, type StrictRead } from './strict-result.js';
import type { BoundedScanVerdict } from './strict-scan.js';
import { sniffId } from './strict-sniff.js';
import type { ScanView } from './strict-views.js';

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
  /** How many malformed or hostile withheld messages end the server (`--strict-max-withheld`). */
  readonly maxWithheld: number;
  /** How many of the kinds a benign server also produces end it; `STRICT_MAX_BENIGN_WITHHELD` when absent. */
  readonly maxBenign?: number;
  /** The scan of all the texts of one message under one hard deadline; see `strict-scan.ts`. */
  readonly scan: (texts: readonly string[], toolName: string) => BoundedScanVerdict;
  /** One JSON message to the client, backpressure honoured. For the short fixed messages Stroq writes itself. */
  readonly toClient: (value: unknown) => Promise<void>;
  /** The same for a line the handler serialised itself, so a failure to serialise is its to handle. */
  readonly toClientLine: (line: string) => Promise<void>;
  /** One JSON message to the server; fire and forget, since the caps bound how many there are. */
  readonly toServer: (value: unknown) => void;
  /** Ends the server process (and, after a grace period, kills it). */
  readonly terminate: () => void;
  /** A line for the proxy's own diagnostics (stderr). */
  readonly note: (text: string) => void;
}

export interface StrictServerHandler {
  readonly onServerLine: (line: SplitLine) => Promise<void>;
  /** True once the server was ended for exceeding a withheld-message cap. */
  readonly wasTerminated: () => boolean;
  /** The cap that ended it (0 until it is ended), for what is said to the client afterwards. */
  readonly terminatedLimit: () => number;
}

/** What an id looks like in an audit line without saying it: a server chose it. */
const describeId = (id: JsonRpcId): string =>
  typeof id === 'string' ? `string of ${id.length} characters` : 'number';

const RESPONSE_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'result', 'error']);
const JSONRPC_VERSION = '2.0';
const BOM = '\uFEFF';

type ResponseMessage = Extract<McpMessage, { kind: 'response' }>;
type ReadOk = Extract<StrictRead, { ok: true }>;
type ServerInitiated = Extract<McpMessage, { kind: 'request' | 'notification' }>;

export function createStrictHandler(deps: StrictHandlerDeps): StrictServerHandler {
  const { ctx, ledger, cloak, maxWithheld } = deps;
  const maxBenign = deps.maxBenign ?? STRICT_MAX_BENIGN_WITHHELD;
  let endedAtLimit = 0;
  let hostileCount = 0;
  let benignCount = 0;
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

  /**
   * Ends the server. The process is stopped FIRST: everything after is a write to a
   * client that may have stopped reading, and a write that never finishes must not be
   * what keeps a hostile server alive. Then it says why (audit, stderr) and answers
   * every request still waiting. `crossing` is the message that went over the cap: it is
   * audited like the ones before it, so the log shows which one was the last.
   */
  async function endServer(
    also: TrackedRequest | null,
    limit: number,
    crossing: {
      readonly reason: WithholdReason;
      readonly toolName: string;
      readonly summary: string;
    },
  ): Promise<void> {
    // The flag and the ledger are changed in ONE synchronous step, before the first await.
    // The pump records a request and writes it to the server in one step too, after testing
    // this flag (`sendToServer` in `proxy-pump.ts`), so a request is either in what is
    // drained here, and answered below, or it never gets past that test: answered there,
    // not tracked, not written. Nothing can fall between the two.
    terminated = true;
    endedAtLimit = limit;
    const waiting = [...(also === null ? [] : [also]), ...ledger.drain()];
    deps.terminate();
    await audit(crossing.reason, crossing.toolName, crossing.summary);
    try {
      await denyDirectly(
        {
          sessionId: ctx.sessionId,
          toolName: toolOf('strict_terminated'),
          toolInput: {},
          cwd: ctx.cwd,
        },
        terminatedDecision(limit),
        `mcp strict: the server had more than ${limit} messages withheld and was ended`,
        () => ({ stdout: '', exitCode: 0 }),
      );
    } catch (err) {
      logError('mcp strict audit', err);
    }
    deps.note(
      `stroq mcp: strict mode ended the server "${ctx.server}": more than ${limit} of its messages were withheld (see stroq log)\n`,
    );
    for (const request of waiting) await deps.toClient(terminatedResponse(request.id, limit));
  }

  /**
   * The answer for a request this handler had already taken from the ledger when the
   * server was ended. The end drained only what was still in the ledger, so a request
   * taken before it is this handler's to answer, and it is answered with what the ones
   * the end answered got. Nothing else answers it, so it is answered exactly once.
   */
  const answerEnded = (request: TrackedRequest | null): Promise<void> =>
    request === null
      ? Promise.resolve()
      : deps.toClient(terminatedResponse(request.id, endedAtLimit));

  /**
   * One withheld message: counted toward the cap for its kind, audited and, if it belongs
   * to a request, answered. The answer is written even when the audit fails, so no
   * addressable request is ever left waiting. `method` is the method of a message the
   * server started, which decides whether it is the chatty kind.
   */
  async function withhold(
    reason: WithholdReason,
    options: {
      readonly toolName: string;
      readonly summary: string;
      readonly answers?: TrackedRequest | null;
      readonly toServer?: Record<string, unknown>;
      readonly method?: string;
      /** Whether the server-initiated message had an `id` member, usable or not. */
      readonly hasId?: boolean;
    },
  ): Promise<void> {
    if (terminated) return answerEnded(options.answers ?? null);
    const hostile = countClass(reason, options.method, options.hasId) === 'hostile';
    const count = hostile ? (hostileCount += 1) : (benignCount += 1);
    const limit = hostile ? maxWithheld : maxBenign;
    const answers = options.answers ?? null;
    if (count > limit)
      return endServer(answers, limit, {
        reason,
        toolName: options.toolName,
        summary: options.summary,
      });
    await audit(reason, options.toolName, options.summary);
    // The audit was an await: the server may have been ended during it, and a server that
    // was ended is refused nothing and delivered nothing more.
    if (terminated) return answerEnded(answers);
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

  /**
   * One view through the engine: its outcome, or why the result cannot be delivered. A
   * result the engine declined to scan is one nobody read, and one it ran out of time on
   * was not read to the end: neither is a clean result.
   */
  async function scanView(
    entry: TrackedRequest,
    view: ScanView,
    reading: PostReading,
    readings: PostReadings,
  ): Promise<PostOutcome | WithholdReason> {
    const outcome = await scanPostResult(
      ctx.engine,
      {
        sessionId: ctx.sessionId,
        toolName: entry.toolName,
        // The default proxy's audit line names the method alone; the other views say which they are.
        toolInput:
          view.name === 'default'
            ? { method: entry.method }
            : { method: entry.method, view: view.name },
        cwd: ctx.cwd,
      },
      view.text,
      reading,
      readings,
    );
    if (!outcome.scanned) return 'scan-failed';
    return outcome.timedOut === true ? 'scan-timeout' : outcome;
  }

  /**
   * Scans every view of a result and returns the engine's outcome for it, or the reason
   * it cannot be delivered. The dry run takes all the texts together, so they share one
   * deadline; the engine then scans them one after the other. The result is as suspect as
   * its worst view, and carries ONE warning: the first suspect view's.
   *
   * Only one call to the engine is the record of the result, so that what is audited is
   * what the default proxy audits (one line) and what is remembered is each atom once: the
   * first view's. The others are extra readings, scanned FIRST so the record can be told if
   * any of them matched (what is remembered of a result that was suspect in any view is
   * flagged as suspect), and audited only when they matched. The record is handed their
   * texts as well, because a view can hold what the first does not (an embedded resource's
   * text behind an outer text, `_meta`, a key): the atoms of every view are remembered, with
   * the cap of atoms per text each always had.
   */
  async function scanned(
    entry: TrackedRequest,
    views: readonly ScanView[],
  ): Promise<PostOutcome | WithholdReason> {
    try {
      const verdict = deps.scan(
        views.map((view) => view.text),
        entry.toolName,
      );
      if (verdict !== 'ok') return verdict === 'timeout' ? 'scan-timeout' : 'scan-failed';
      const [recorded, ...extras] = views as readonly [ScanView, ...ScanView[]];
      const readings = createPostReadings();
      const extraOutcomes: PostOutcome[] = [];
      for (const view of extras) {
        const outcome = await scanView(entry, view, { extraReading: true }, readings);
        if (typeof outcome === 'string') return outcome;
        extraOutcomes.push(outcome);
      }
      const matched = extraOutcomes.some((outcome) => outcome.warning !== null);
      const first = await scanView(
        entry,
        recorded,
        {
          ...(extras.length === 0 ? {} : { otherReadings: extras.map((view) => view.text) }),
          ...(matched ? { suspectInAnotherReading: true } : {}),
        },
        readings,
      );
      if (typeof first === 'string') return first;
      return [first, ...extraOutcomes].find((outcome) => outcome.warning !== null) ?? first;
    } catch (err) {
      logError('mcp strict scan', err);
      return 'scan-failed';
    }
  }

  async function onResponse(message: ResponseMessage): Promise<void> {
    const { id } = message;
    // An integer beyond 2^53 does not survive being written again: it would reach the
    // client as a different number. No request of a client has one.
    if (typeof id === 'number' && !Number.isSafeInteger(id))
      return withhold('invalid-shape', {
        toolName: toolOf('unreadable_server_message'),
        summary: 'withheld a response whose id is not a safe integer or a string',
      });
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
    // From here the request is taken and has to be answered, whatever goes wrong.
    try {
      return await answer(entry, message);
    } catch (err) {
      logError('mcp strict response', err);
      return withhold('scan-failed', {
        toolName: entry.toolName,
        answers: entry,
        summary: `withheld a ${describeMethod(entry.method)} response after an internal error`,
      });
    }
  }

  async function answer(entry: TrackedRequest, message: ResponseMessage): Promise<void> {
    const { value } = message;
    const about = { toolName: entry.toolName, answers: entry };
    const isError = Object.hasOwn(value, 'error');
    // `jsonrpc` is delivered as it came, so it is held to the one value it can have.
    if (
      value['jsonrpc'] !== JSONRPC_VERSION ||
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
    return deliver(entry, message, read);
  }

  async function deliver(
    entry: TrackedRequest,
    message: ResponseMessage,
    read: ReadOk,
  ): Promise<void> {
    const { value } = message;
    const about = { toolName: entry.toolName, answers: entry };
    // The post-condition of the whole mode, checked on the structure about to be sent:
    // every string in it is a string of the decoded-strings view that is about to be
    // scanned. It holds by the way the text is built; this is the check that notices the
    // day it stops holding.
    const body = Object.hasOwn(value, 'error') ? value['error'] : value['result'];
    if (!isCovered(body, read.media, read.text))
      return withhold('unread-content', {
        ...about,
        summary: `withheld a ${describeMethod(entry.method)} response with strings outside the scan text`,
      });
    // A result with nothing in it that the default proxy would scan has no views at all.
    const outcome = read.views.length === 0 ? null : await scanned(entry, read.views);
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
    if (isRecord(result) && entry.method === 'tools/call')
      result = appendBlocks(result, [warning, notice]);
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
    // The scan (and the cloak) before this were awaits: a response that was being read
    // when the server was ended is not delivered, and its request is answered as the end.
    if (terminated) return answerEnded(entry);
    let line: string;
    try {
      line = strictLine(message);
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
    const forward = forwardableServerMessage(message);
    if (forward !== null) return deps.toClient(forward);
    return withhold('unsolicited', {
      method: message.method,
      hasId: Object.hasOwn(message.value, 'id'),
      toolName: toolOf('unsolicited_server_message'),
      summary: `withheld a server ${message.kind} (${describeMethod(message.method)})`,
      ...(message.kind === 'request' ? { toServer: refusedServerRequest(message.id) } : {}),
    });
  }

  async function handle(line: SplitLine): Promise<void> {
    if (line.oversize) return onOversize(line);
    // Nothing to scan and nothing to deliver: not a message, and not held against the server.
    if (line.text.trim() === '') return;
    // A few servers write a byte-order mark before their JSON; `JSON.parse` rejects it.
    const text = line.text.startsWith(BOM) ? line.text.slice(BOM.length) : line.text;
    const value = parseLine(text);
    if (value === undefined)
      return withholdUnaddressed('unparsable', 'a server line that is not JSON', text);
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
    terminatedLimit: () => endedAtLimit,
    onServerLine: async (line) => {
      if (terminated) return;
      await handle(line);
    },
  };
}
