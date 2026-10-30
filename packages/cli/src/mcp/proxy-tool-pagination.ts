import { randomUUID } from 'node:crypto';
import { asJsonRpcId, classifyMessage, keyOf, type JsonRpcId, type SplitLine } from './framing.js';
import { contractRecord, parseToolContractJson } from './tool-contract-canonical.js';
import { createToolContractPages } from './tool-contract-pages.js';
import { toolApprovalResponse, type ToolApprovalConnection } from './proxy-tool-approval.js';
import type { StrictLedger, TrackedRequest } from './strict-ledger.js';
import { STRICT_CANCELLED_MEMORY } from './strict-limits.js';

export const TOOL_PAGE_ID_PREFIX = 'stroq-tools:';
export const isToolPageId = (id: unknown): id is string =>
  typeof id === 'string' && id.startsWith(TOOL_PAGE_ID_PREFIX);
interface Exchange {
  readonly root: TrackedRequest;
  readonly pages: ReturnType<typeof createToolContractPages>;
  readonly entries: Set<TrackedRequest>;
  readonly timer: NodeJS.Timeout;
  readonly deadline: number;
  closed: boolean;
}
export interface ToolPaginationDeps {
  readonly approval: ToolApprovalConnection;
  readonly ledger: StrictLedger;
  readonly sendInternal: (
    entry: TrackedRequest,
    message: Record<string, unknown>,
    live: () => boolean,
  ) => void;
  readonly cancelInternal: (id: JsonRpcId) => void;
  readonly enqueueReply: (reply: () => Promise<void>) => void;
  readonly reply: (value: Record<string, unknown>) => Promise<void>;
  readonly timeoutMs?: number;
}
/** Owns original request completion while each scanned page leaves the server queue free. */
export function createToolPagination(deps: ToolPaginationDeps) {
  let active: Exchange | null = null;
  let sequence = 0;
  let closed = false;
  const namespace = TOOL_PAGE_ID_PREFIX + randomUUID().replaceAll('-', '') + ':';
  const owners = new WeakMap<TrackedRequest, Exchange>();
  const internal = new Map<string, TrackedRequest>();
  const retired = new Set<string>();
  const skipped = new WeakSet<SplitLine>();
  const conflicting = new WeakSet<SplitLine>();
  const clientSeen = new WeakSet<SplitLine>();
  const consumedCancellations = new WeakSet<SplitLine>();
  const remember = (id: JsonRpcId): void => {
    if (!isToolPageId(id)) return;
    retired.add(id);
    for (const oldest of retired) {
      if (retired.size <= STRICT_CANCELLED_MEMORY) break;
      retired.delete(oldest);
    }
  };
  const live = (exchange: Exchange): boolean =>
    !closed &&
    !exchange.closed &&
    active === exchange &&
    Date.now() < exchange.deadline &&
    deps.approval.isTrackedCurrent(exchange.root);
  const settle = (exchange: Exchange, refuse: boolean): void => {
    if (exchange.closed) return;
    exchange.closed = true;
    clearTimeout(exchange.timer);
    if (active === exchange) active = null;
    for (const entry of exchange.entries) {
      deps.ledger.cancel(entry.id);
      deps.approval.finish(entry);
      internal.delete(keyOf(entry.id));
      remember(entry.id);
    }
    if (refuse) deps.enqueueReply(() => deps.reply(toolApprovalResponse(exchange.root.id)));
  };
  const fail = (exchange: Exchange): void => {
    deps.approval.failed();
    settle(exchange, true);
  };
  const failActive = (): void => {
    deps.approval.failed();
    if (active) settle(active, true);
  };
  const stale = (): void => {
    if (active && !live(active)) {
      if (Date.now() >= active.deadline) fail(active);
      else settle(active, true);
    }
  };
  const cancel = (id: JsonRpcId): boolean => {
    if (!active || active.root.id !== id) return false;
    const waiting = [...active.entries].filter((entry) => internal.get(keyOf(entry.id)) === entry);
    deps.approval.failed();
    settle(active, false);
    for (const entry of waiting) deps.cancelInternal(entry.id);
    return true;
  };
  const makePage = (exchange: Exchange, message: Record<string, unknown>) => {
    const id = namespace + String(++sequence);
    const entry = { id, method: 'tools/list', toolName: exchange.root.toolName };
    exchange.entries.add(entry);
    owners.set(entry, exchange);
    internal.set(keyOf(id), entry);
    return { entry, message: { ...message, id }, live: () => live(exchange) };
  };
  return {
    /** Reserve the root until final delivery, not merely until page one returns. */
    begin: (entry: TrackedRequest, message: Record<string, unknown>) => {
      if (closed) return null;
      if (active) fail(active);
      let exchange: Exchange;
      const timeout = Math.min(30000, Math.max(1, deps.timeoutMs ?? 30000));
      const timer = setTimeout(() => {
        if (!exchange.closed) fail(exchange);
      }, timeout);
      timer.unref();
      exchange = {
        root: entry,
        pages: createToolContractPages(),
        entries: new Set([entry]),
        timer,
        deadline: Date.now() + timeout,
        closed: false,
      };
      active = exchange;
      owners.set(entry, exchange);
      return makePage(exchange, message);
    },
    owns: (entry: TrackedRequest): boolean => owners.has(entry),
    rootOf: (entry: TrackedRequest): TrackedRequest | undefined => owners.get(entry)?.root,
    isHeld: (entry: TrackedRequest): boolean => {
      const exchange = owners.get(entry);
      return exchange !== undefined && !exchange.closed;
    },
    onIngress: stale,
    onClientIngress: (line: SplitLine): void => {
      if (clientSeen.has(line)) return;
      clientSeen.add(line);
      if (line.oversize) return;
      let value: unknown;
      try {
        value = parseToolContractJson(
          line.text.startsWith('\uFEFF') ? line.text.slice(1) : line.text,
        );
      } catch {
        return;
      }
      const message = classifyMessage(value);
      if (message.kind === 'request' && active?.root.id === message.id) conflicting.add(line);
      if (
        message.kind === 'notification' &&
        message.method.toLowerCase() === 'notifications/cancelled' &&
        message.value['jsonrpc'] === '2.0' &&
        Object.keys(message.value).every((key) =>
          ['jsonrpc', 'id', 'method', 'params'].includes(key),
        ) &&
        contractRecord(message.value['params'])
      ) {
        const id = asJsonRpcId(message.value['params']['requestId']);
        if (id !== null && cancel(id)) consumedCancellations.add(line);
      }
    },
    consumedCancellation: (line: SplitLine): boolean => consumedCancellations.has(line),
    conflictingLine: (line: SplitLine): boolean => conflicting.has(line),
    clientReserved: (id: unknown): boolean => isToolPageId(id),
    conflictingRoot: (id: JsonRpcId): boolean => active?.root.id === id,
    /** Known retired replies are harmless; unknown private IDs abort without being echoed. */
    skipServerLine: (line: SplitLine): boolean => {
      if (skipped.has(line)) return true;
      if (line.oversize || line.text.trim() === '') return false;
      let value: unknown;
      try {
        value = parseToolContractJson(
          line.text.startsWith('\uFEFF') ? line.text.slice(1) : line.text,
        );
      } catch {
        return false;
      }
      const message = classifyMessage(value);
      if (message.kind === 'response' && isToolPageId(message.id)) {
        if (internal.has(keyOf(message.id))) return false;
        if (!retired.has(message.id)) failActive();
        skipped.add(line);
        return true;
      }
      if (message.kind === 'request' && isToolPageId(message.id)) {
        failActive();
        skipped.add(line);
        return true;
      }
      return false;
    },
    cancel,
    failed: (entry?: TrackedRequest): boolean => {
      const exchange = entry ? owners.get(entry) : active;
      if (!exchange) return false;
      if (!exchange.closed) fail(exchange);
      return true;
    },
    finishPage: (entry: TrackedRequest): void => {
      const exchange = owners.get(entry);
      if (!exchange || exchange.root === entry) return;
      deps.approval.finish(entry);
      internal.delete(keyOf(entry.id));
      remember(entry.id);
    },
    accept: (
      entry: TrackedRequest,
      result: unknown,
    ):
      | { kind: 'held' }
      | {
          kind: 'complete';
          root: TrackedRequest;
          result: { tools: unknown[] };
          live: () => boolean;
          delivered: () => void;
          refused: () => void;
          failed: () => void;
        } => {
      const exchange = owners.get(entry);
      if (!exchange || !live(exchange)) {
        if (exchange && !exchange.closed) {
          if (Date.now() >= exchange.deadline) fail(exchange);
          else settle(exchange, true);
        }
        return { kind: 'held' };
      }
      try {
        const page = exchange.pages.add(result);
        if (page.kind === 'complete')
          return {
            kind: 'complete',
            root: exchange.root,
            result: page.result,
            live: () => live(exchange),
            delivered: () => settle(exchange, false),
            refused: () => {
              if (Date.now() >= exchange.deadline) fail(exchange);
              else settle(exchange, true);
            },
            failed: () => fail(exchange),
          };
        const next = makePage(exchange, {
          jsonrpc: '2.0',
          method: 'tools/list',
          params: { cursor: page.cursor },
        });
        deps.sendInternal(next.entry, next.message, next.live);
      } catch {
        fail(exchange);
      }
      return { kind: 'held' };
    },
    close: (silent = false): void => {
      closed = true;
      if (active) {
        deps.approval.failed();
        settle(active, !silent);
      }
    },
  };
}
export type ToolPagination = ReturnType<typeof createToolPagination>;
