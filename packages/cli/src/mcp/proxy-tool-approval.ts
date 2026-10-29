import { isRecord } from '../adapters/tool-input.js';
import { classifyMessage, keyOf, type JsonRpcId, type SplitLine } from './framing.js';
import type { TrackedRequest } from './strict-ledger.js';
import { STRICT_CANCELLED_MEMORY, STRICT_MAX_TRACKED } from './strict-limits.js';
import { readStrictError, readStrictResult } from './strict-result.js';
import { parseToolContractJson } from './tool-contract-canonical.js';
import { boundContractCapture } from './tool-contract-record.js';
import type { createMcpToolContractsStore, ToolContractBinding } from './tool-contracts.js';
import { denyDirectly } from '../adapters/pre-decision.js';
import { mcpToolName } from '../adapters/cursor-mcp-name.js';
import { logError } from '../log.js';
import type { McpContext } from './judge.js';
import {
  messageRefusal,
  readApprovalMessage,
  type MessageProblem,
} from './proxy-tool-approval-read.js';

type Store = Pick<
  ReturnType<typeof createMcpToolContractsStore>,
  'observe' | 'invalidate' | 'withApproved'
>;
interface Ingress {
  readonly valid: boolean;
  readonly value: unknown;
  readonly epoch: number;
  /** Why the message is refused on its own (a client is told; a server's is withheld); else null. */
  readonly problem: MessageProblem | null;
}
/** What one line means: whether it may go on, and whether it ends current authority. */
interface Verdict extends Omit<Ingress, 'epoch'> {
  readonly revoke: boolean;
}
interface Current {
  readonly epoch: number;
  readonly sha256: string;
  readonly names: ReadonlySet<string>;
}
const methodOf = (value: unknown): string =>
  isRecord(value) && typeof value['method'] === 'string' ? value['method'].toLowerCase() : '';
const CLIENT_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'method', 'params']);
const RESPONSE_KEYS: ReadonlySet<string> = new Set(['jsonrpc', 'id', 'result', 'error']);
const revoked = (value: unknown): Verdict => ({ valid: false, value, problem: null, revoke: true });
/** A listing becomes stored authority, so its raw text is held to the tool-contract rules. */
const contractReadable = (text: string): boolean => {
  try {
    parseToolContractJson(text.startsWith('\uFEFF') ? text.slice(1) : text);
    return true;
  } catch {
    return false;
  }
};

/**
 * A client message never ends current authority by being malformed: one Stroq cannot read
 * exactly is refused on its own and is never written to the server, so the server cannot have
 * acted on it. The one client line that does end it is a listing request (C1, any spelling):
 * a new discovery replaces the old one, by design.
 */
function clientVerdict(line: SplitLine): Verdict {
  if (line.oversize)
    return { valid: false, value: undefined, problem: 'unreadable', revoke: false };
  const { value, problem } = readApprovalMessage(line.text);
  if (problem !== null) return { valid: false, value, problem, revoke: false };
  const kind = classifyMessage(value).kind;
  const supported =
    isRecord(value) &&
    value['jsonrpc'] === '2.0' &&
    (kind === 'response' ||
      ((kind === 'request' || kind === 'notification') &&
        Object.keys(value).every((key) => CLIENT_KEYS.has(key)) &&
        (value['params'] === undefined || isRecord(value['params']))));
  if (!supported) return { valid: false, value, problem: 'unsupported', revoke: false };
  return { valid: true, value, problem: null, revoke: methodOf(value) === 'tools/list' };
}

/** Fixed refusal text never repeats a server-selected name, schema, or storage error. */
export const toolApprovalResponse = (id: JsonRpcId): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32001,
    message:
      'Stroq withheld this operation: the complete current MCP tool contract is not approved. Review it in the local console, then explicitly retry.',
  },
});

export async function auditToolApprovalRefusal(
  ctx: McpContext,
  method: 'tools/list' | 'tools/call',
): Promise<void> {
  try {
    await denyDirectly(
      {
        sessionId: ctx.sessionId,
        toolName: mcpToolName(ctx.server, 'tool_contract'),
        toolInput: { method },
        cwd: ctx.cwd,
      },
      {
        effect: 'deny',
        ruleId: 'mcp-tool-contract-not-approved',
        reason: 'The complete current advertised MCP interface has not been explicitly approved.',
      },
      'mcp tool contracts: withheld an operation without a complete current approved interface',
      () => ({ stdout: '', exitCode: 0 }),
    );
  } catch (error) {
    logError('mcp tool contract audit', error);
  }
}

/** Per-connection freshness is separate from durable operator approval. Never restore it from disk. */
export function createToolApprovalConnection({
  store,
  binding,
}: {
  readonly store: Store;
  readonly binding: ToolContractBinding;
}) {
  let epoch = 0;
  let invalidatedEpoch = -1;
  let current: Current | null = null;
  const clientIngress = new WeakMap<SplitLine, Ingress>();
  const serverIngress = new WeakMap<SplitLine, Ingress>();
  const tracked = new WeakMap<TrackedRequest, Ingress>();
  const pending = new Map<string, TrackedRequest>();
  const responses = new WeakSet<TrackedRequest>();
  /** Ids the client cancelled while waiting: one late answer each is expected, not a forgery. */
  const cancelled = new Set<string>();
  /** Why `admit` turned a readable request away, for the answer `refusal` gives it. */
  const unadmitted = new WeakMap<SplitLine, MessageProblem>();
  let storage: Promise<void> = Promise.resolve();
  let scheduled = false;
  const invalidate = (): void => {
    epoch += 1;
    current = null;
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void persistInvalidation().catch(() => undefined);
    });
  };
  const persistInvalidation = (): Promise<void> => {
    const selected = epoch;
    storage = storage
      .catch(() => undefined)
      .then(async () => {
        if (invalidatedEpoch >= selected) return;
        await store.invalidate(binding, 'invalidated');
        invalidatedEpoch = selected;
      });
    return storage;
  };
  /**
   * A server line ends current authority only when the contract changed or the proxy can no
   * longer tell what the server said or whom it answered. Each such case is named here and has a
   * row in `proxy-tool-approval-revocation.test.ts`:
   *
   * - S1 a line too long to read, S2 one that is not JSON, is not one object, or repeats a key:
   *   either could be a `list_changed` the proxy did not see;
   * - S3 `notifications/tools/list_changed` itself;
   * - S4 an answer to no waiting request, a second answer, an envelope JSON-RPC does not define,
   *   or an error that is not an error object: a forged or replayed reply;
   * - S5 a listing that cannot be captured (authority already ended when it was asked for).
   *
   * Everything else answers or concerns one message: a log line, a sampling request, a result
   * strict mode cannot read or a number it would round is withheld by strict mode for itself.
   */
  const serverVerdict = (line: SplitLine): Verdict => {
    if (line.oversize) return revoked(undefined);
    const read = readApprovalMessage(line.text);
    const { value } = read;
    if (read.problem === 'unreadable' || read.problem === 'ambiguous' || !isRecord(value))
      return revoked(value);
    const message = classifyMessage(value);
    // What the server starts is strict mode's to forward or withhold; it never carries a contract.
    // An inexact number in it (a progress count, say) would reach the client rounded: withheld.
    if (message.kind === 'request' || message.kind === 'notification')
      return {
        valid: read.problem === null,
        value,
        problem: read.problem,
        revoke: methodOf(value) === 'notifications/tools/list_changed',
      };
    if (message.kind !== 'response') return revoked(value);
    const key = keyOf(message.id);
    const request = pending.get(key);
    // The late answer to a cancelled request: strict mode drops it without counting it.
    if (request === undefined && cancelled.delete(key))
      return { valid: true, value, problem: null, revoke: false };
    const hasError = Object.hasOwn(value, 'error');
    if (
      request === undefined ||
      responses.has(request) ||
      value['jsonrpc'] !== '2.0' ||
      !Object.keys(value).every((k) => RESPONSE_KEYS.has(k)) ||
      (hasError && Object.hasOwn(value, 'result'))
    )
      return revoked(value);
    responses.add(request);
    if (hasError) {
      const error = readStrictError(value['error']);
      if (!error.ok && error.reason === 'invalid-shape') return revoked(value);
    } else if (request.method === 'tools/list') {
      const listed =
        contractReadable(line.text) && readStrictResult('tools/list', value['result']).ok;
      return { valid: listed, value, problem: null, revoke: !listed };
    }
    // An inexact number would reach the client rounded: that one answer is withheld instead.
    return { valid: read.problem === null, value, problem: read.problem, revoke: false };
  };
  const ingress = (line: SplitLine, client: boolean): Ingress => {
    const cache = client ? clientIngress : serverIngress;
    const old = cache.get(line);
    if (old) return old;
    const { revoke, ...verdict } = client ? clientVerdict(line) : serverVerdict(line);
    if (revoke) invalidate();
    const found = { ...verdict, epoch };
    cache.set(line, found);
    return found;
  };
  const same = (selected: Current): boolean => current === selected && epoch === selected.epoch;
  const guard = async (
    selected: Current,
    name: string | null,
    write: () => void,
    live: () => boolean = () => true,
  ): Promise<boolean> => {
    if (!live() || !same(selected) || (name !== null && !selected.names.has(name))) return false;
    let sent = false;
    try {
      await persistInvalidation();
      if (!live() || !same(selected)) return false;
      await store.withApproved(binding, selected.sha256, name, () => {
        if (!live() || !same(selected)) return;
        write();
        sent = true;
      });
    } catch {
      return sent;
    }
    return sent;
  };
  return {
    onClientIngress: (line: SplitLine): void => {
      ingress(line, true);
    },
    onServerIngress: (line: SplitLine): void => {
      if (line.text.trim() !== '' || line.oversize) ingress(line, false);
    },
    invalidate,
    /**
     * Tampering the pump or the listing walk sees for itself (C2: a request under the proxy's
     * private id prefix, a server reply to one it never sent) and a listing walk that failed.
     */
    failed: (): void => {
      invalidate();
    },
    clientValid: (line: SplitLine): boolean => ingress(line, true).valid,
    serverValid: (line: SplitLine): boolean => ingress(line, false).valid,
    /** Whether a refused server line was refused only for a number it would deliver rounded. */
    serverInexact: (line: SplitLine): boolean => {
      const verdict = ingress(line, false);
      return !verdict.valid && verdict.problem === 'inexact';
    },
    /**
     * The answer to a client request `clientValid` or `admit` refused, saying why. It is refused on
     * its own and never forwarded; approvals are left as they were.
     */
    refusal: (line: SplitLine, id: JsonRpcId): Record<string, unknown> =>
      messageRefusal(unadmitted.get(line) ?? ingress(line, true).problem ?? 'unsupported', id),
    admit: (line: SplitLine, id: JsonRpcId, method: string): boolean => {
      const captured = ingress(line, true);
      if (!captured.valid) return false;
      const key = keyOf(id);
      // An id that cannot be paired with exactly one answer: inexact, still open, or cancelled
      // with its late answer possibly still on the way; or no room to track one more.
      if (
        (typeof id === 'number' && !Number.isSafeInteger(id)) ||
        pending.has(key) ||
        cancelled.has(key) ||
        pending.size >= STRICT_MAX_TRACKED
      ) {
        unadmitted.set(line, 'unpaired');
        return false;
      }
      if (method.toLowerCase() !== 'tools/list') return true;
      const params = isRecord(captured.value) ? captured.value['params'] : undefined;
      const plain =
        method === 'tools/list' &&
        (params === undefined ||
          (isRecord(params) && Object.keys(params).every((key) => key === '_meta')));
      if (!plain) unadmitted.set(line, 'unsupported');
      return plain;
    },
    track: (line: SplitLine, request: TrackedRequest): void => {
      tracked.set(request, ingress(line, true));
      pending.set(keyOf(request.id), request);
    },
    finish: (request: TrackedRequest): void => {
      if (pending.get(keyOf(request.id)) === request) pending.delete(keyOf(request.id));
    },
    isTrackedCurrent: (request: TrackedRequest): boolean => {
      const capture = tracked.get(request);
      return capture?.valid === true && capture.epoch === epoch;
    },
    trackInternal: (root: TrackedRequest, entry: TrackedRequest): void => {
      const capture = tracked.get(root);
      if (capture === undefined) return;
      tracked.set(entry, capture);
      pending.set(keyOf(entry.id), entry);
    },
    /** Bookkeeping for one id: approvals and every other request stay as they are. */
    cancel: (id: JsonRpcId): void => {
      const key = keyOf(id);
      if (!pending.delete(key)) return;
      cancelled.add(key);
      for (const oldest of cancelled) {
        if (cancelled.size <= STRICT_CANCELLED_MEMORY) break;
        cancelled.delete(oldest);
      }
    },
    canCall: (line: SplitLine, name: unknown): boolean => {
      const seen = ingress(line, true);
      return (
        seen.valid &&
        typeof name === 'string' &&
        current !== null &&
        seen.epoch === epoch &&
        current.names.has(name)
      );
    },
    dispatch: async (line: SplitLine, name: string, write: () => void): Promise<boolean> => {
      const seen = ingress(line, true);
      const selected = current;
      return (
        seen.valid &&
        selected !== null &&
        seen.epoch === selected.epoch &&
        guard(selected, name, write)
      );
    },
    deliverList: async (
      entry: TrackedRequest,
      line: SplitLine,
      result: unknown,
      write: () => void,
    ): Promise<boolean> => {
      const request = tracked.get(entry);
      const response = ingress(line, false);
      if (!request?.valid || !response.valid || request.epoch !== epoch) return false;
      return publishComplete(entry, result, write);
    },
    publishComplete,
  };

  async function publishComplete(
    entry: TrackedRequest,
    result: unknown,
    write: () => void,
    live: () => boolean = () => true,
  ): Promise<boolean> {
    const request = tracked.get(entry);
    if (!live() || !request?.valid || request.epoch !== epoch) return false;
    try {
      const canonical = boundContractCapture(binding, result);
      await persistInvalidation();
      if (!live() || request.epoch !== epoch) return false;
      const snapshot = await store.observe(binding, result);
      if (!live() || request.epoch !== epoch) {
        await store.invalidate(binding, 'invalidated');
        return false;
      }
      if (snapshot.capture?.sha256 !== canonical.sha256) return false;
      const selected = {
        epoch,
        sha256: canonical.sha256,
        names: new Set(canonical.tools.map((tool) => tool.name)),
      };
      current = selected;
      return await guard(selected, null, write, live);
    } catch {
      invalidate();
      await persistInvalidation().catch(() => undefined);
      return false;
    }
  }
}
export type ToolApprovalConnection = ReturnType<typeof createToolApprovalConnection>;
