import { isRecord } from '../adapters/tool-input.js';

/**
 * The wire layer of the MCP proxy: turning two byte streams into lines without
 * losing a byte, deciding what kind of JSON-RPC message a line carries, and
 * remembering which request ids are still waiting for a result worth scanning.
 * Nothing here talks to the engine — see `judge.ts` — and nothing here ever rewrites
 * a line: `SplitLine.text` is the exact text that arrived, and `SplitLine.eol` is the
 * exact terminator that followed it, so forwarding is `text + eol` and nothing else.
 *
 * `createLineSplitter` holds pending chunks in an array and joins them at most once
 * per line — when the line completes, or, in streaming mode, when it first crosses
 * `MAX_LINE_CHARS` — rather than re-concatenating and re-scanning an ever-growing
 * string on every chunk, which used to make accumulating one long line quadratic in
 * its length (and, eventually, an unhandled `RangeError` once the buffer neared V8's
 * string-length limit).
 *
 * That still leaves a choice for a line that crosses `MAX_LINE_CHARS`, and the two
 * directions need different answers. `createLineSplitter({ streamOversize: true })`
 * — the server side — bounds memory by emitting the line as a run of consecutive
 * oversize `SplitLine` segments as data arrives: all but the last have `eol: ''`,
 * only the last carries the real terminator, and the run is forwarded verbatim and
 * in order without ever being parsed, because a multi-gigabyte server line is never
 * going to be judged anyway (see `MAX_LINE_CHARS`). `createLineSplitter()` — the
 * default, and the client side — always buffers a line whole and emits it as a
 * single `SplitLine`, however large, because a client line is always parsed and
 * judged in full; streaming a big `tools/call` through unparsed would be exactly the
 * bypass this proxy exists to prevent.
 */

/**
 * The largest SERVER line the proxy will hand to `JSON.parse`. A message past this
 * is forwarded to the client unparsed and logged: a hostile server that emits one
 * enormous line would otherwise stall the proxy inside the parser and take the
 * client's session with it. Client lines are always parsed however large they are —
 * a `tools/call` is the thing Stroq exists to judge, and declining to judge a big one
 * is exactly the bypass. This bounds the PARSE, not the buffer: framing has to
 * accumulate a line either way. Measured in decoded UTF-16 code units, not bytes:
 * that is the same thing for the ASCII JSON these streams mostly carry, but not in
 * general — 8,388,608 copies of a non-ASCII character such as 'あ' is exactly
 * `MAX_LINE_CHARS` UTF-16 code units (so not oversize) while being 24 MiB of UTF-8
 * on the wire. The bound tracks decoded JS string length, not serialized size.
 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** One line as it arrived. */
export interface SplitLine {
  /** The line without its terminator, byte for byte as it was decoded. */
  readonly text: string;
  /** `'\n'` for a terminated line, `''` for the final unterminated remainder. */
  readonly eol: '\n' | '';
  /**
   * True when this line's own length is past `MAX_LINE_CHARS`, counted the same
   * way `MAX_LINE_CHARS` is (UTF-16 code units, not bytes). In streaming mode, a
   * single oversize input line arrives as a run of consecutive `SplitLine` values
   * that are all `oversize: true`, with `eol: ''` on every one but the last of the
   * run — treat the whole run as one line: forward each segment verbatim and in
   * order, and never parse one on its own.
   */
  readonly oversize: boolean;
}

export interface LineSplitter {
  /** Every line this chunk completed, in arrival order — or, in streaming mode, every oversize segment. */
  push(chunk: string): readonly SplitLine[];
  /** The unterminated remainder at end of stream, or `[]` when there is none. */
  flush(): readonly SplitLine[];
}

/**
 * Both streams are read with `setEncoding('utf8')`, so chunks arrive already decoded
 * and a multi-byte character straddling a chunk boundary is never split in half here.
 *
 * `options.streamOversize` (default `false`) picks which contract documented on
 * `SplitLine.oversize` applies — see the module comment above for why the two
 * directions differ. Only the newly arrived chunk is ever scanned for `\n`, and
 * pending fragments are joined at most once per line, so accumulating a line costs
 * work proportional to its length, not its length squared, in either mode.
 */
export function createLineSplitter(options?: { readonly streamOversize?: boolean }): LineSplitter {
  const streamOversize = options?.streamOversize ?? false;
  let pending: string[] = [];
  let pendingLength = 0;
  // Streaming mode only: true while the line under construction has already
  // crossed MAX_LINE_CHARS and is being handed out as it arrives rather than
  // being buffered further.
  let inOversizeLine = false;

  /** Joins and clears whatever is pending. Called at most once per line. */
  const drainPending = (): string => {
    const text = pending.join('');
    pending = [];
    pendingLength = 0;
    return text;
  };

  return {
    push(chunk: string): readonly SplitLine[] {
      const lines: SplitLine[] = [];
      let searchStart = 0;
      for (;;) {
        const nl = chunk.indexOf('\n', searchStart);
        if (nl === -1) {
          const rest = chunk.slice(searchStart);
          if (rest.length > 0) {
            if (streamOversize && inOversizeLine) {
              // Still inside an oversize line: hand this fragment straight
              // through rather than adding it to a buffer that would only grow
              // without bound for a line the server never terminates.
              lines.push({ text: rest, eol: '', oversize: true });
            } else {
              pending.push(rest);
              pendingLength += rest.length;
              if (streamOversize && pendingLength > MAX_LINE_CHARS) {
                inOversizeLine = true;
                lines.push({ text: drainPending(), eol: '', oversize: true });
              }
            }
          }
          break;
        }
        const segment = chunk.slice(searchStart, nl);
        if (streamOversize && inOversizeLine) {
          // The `\n` that ends the oversize line: close out the run.
          lines.push({ text: segment, eol: '\n', oversize: true });
          inOversizeLine = false;
        } else {
          pending.push(segment);
          pendingLength += segment.length;
          const text = drainPending();
          lines.push({ text, eol: '\n', oversize: text.length > MAX_LINE_CHARS });
        }
        searchStart = nl + 1;
      }
      return lines;
    },
    flush(): readonly SplitLine[] {
      if (inOversizeLine) {
        // Every byte of the unterminated tail was already streamed out by
        // push() above; there is nothing left buffered to return.
        inOversizeLine = false;
        return [];
      }
      if (pending.length === 0) return [];
      const text = drainPending();
      return [{ text, eol: '', oversize: text.length > MAX_LINE_CHARS }];
    },
  };
}

/** `JSON.parse`, with a line that is not JSON at all reported as `undefined`. */
export function parseLine(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON-RPC id. Never `null`, never empty, and string ids are a separate namespace from number ids. */
export type JsonRpcId = string | number;

export function asJsonRpcId(value: unknown): JsonRpcId | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/** What one parsed line turned out to be. `value` is the parsed object, unmodified. */
export type McpMessage =
  | {
      readonly kind: 'request';
      readonly id: JsonRpcId;
      readonly method: string;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: 'notification';
      readonly method: string;
      readonly value: Record<string, unknown>;
    }
  | { readonly kind: 'response'; readonly id: JsonRpcId; readonly value: Record<string, unknown> }
  | { readonly kind: 'batch'; readonly items: readonly unknown[] }
  | { readonly kind: 'other' };

export function classifyMessage(value: unknown): McpMessage {
  if (Array.isArray(value)) return { kind: 'batch', items: value };
  if (!isRecord(value)) return { kind: 'other' };
  const method = value['method'];
  const id = asJsonRpcId(value['id']);
  if (typeof method === 'string')
    return id === null
      ? { kind: 'notification', method, value }
      : { kind: 'request', id, method, value };
  // `hasOwn` rather than truthiness: `{ id, result: null }` is a real response.
  if (id !== null && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error')))
    return { kind: 'response', id, value };
  return { kind: 'other' };
}

/** A message's `params` as a record; anything else is `{}`. */
export const paramsOf = (message: Record<string, unknown>): Record<string, unknown> =>
  isRecord(message['params']) ? message['params'] : {};

/** The `jsonrpc` version to echo on a reply the proxy writes itself. */
export const jsonrpcOf = (message: Record<string, unknown>): string =>
  typeof message['jsonrpc'] === 'string' ? message['jsonrpc'] : '2.0';

/** The `_meta` key by which a 2026-07-28 request declares its protocol version. */
export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';

const metaHasProtocol = (value: unknown): boolean =>
  isRecord(value) && typeof value[PROTOCOL_VERSION_META] === 'string';

/**
 * True when the request declares the modern protocol, i.e. expects a `resultType` on
 * every result. Checked in `params._meta`, where MCP puts it, and at the top level,
 * where some drafts do — a reply that omits `resultType` for a modern client is
 * malformed, and one that adds it for a legacy client is an unknown key.
 */
export function hasProtocolMeta(message: Record<string, unknown>): boolean {
  if (metaHasProtocol(message['_meta'])) return true;
  const params = message['params'];
  return isRecord(params) && metaHasProtocol(params['_meta']);
}

/** The four request methods whose result carries content the model will read. */
export const SCANNED_METHODS = [
  'tools/call',
  'tools/list',
  'resources/read',
  'prompts/get',
] as const;
export type ScannedMethod = (typeof SCANNED_METHODS)[number];
export const isScannedMethod = (method: string): method is ScannedMethod =>
  (SCANNED_METHODS as readonly string[]).includes(method);

/** What the proxy remembered about a request so its response can be scanned. */
export interface PendingRequest {
  readonly method: ScannedMethod;
  /** The Stroq tool name the result is audited and warned under. */
  readonly toolName: string;
}

/**
 * The most requests the proxy will remember at once. A server that never answers
 * would otherwise let a client grow this table for as long as the proxy runs, which
 * is days. Oldest go first: the entries most likely to be dead.
 */
export const MAX_PENDING = 4096;

const keyOf = (id: JsonRpcId): string => (typeof id === 'string' ? `s:${id}` : `n:${id}`);

export class PendingTable {
  private readonly entries = new Map<string, PendingRequest>();

  get size(): number {
    return this.entries.size;
  }

  /**
   * A client reusing an id that is still pending overwrites its entry — the
   * response is then attributed to this newer request's method and tool name —
   * but `Map.set` on an existing key does not move it in iteration order, so the
   * refreshed entry keeps its original, older eviction position rather than being
   * treated as freshly inserted. That is by design: a well-behaved client never
   * reuses a pending id, and re-inserting to refresh position would cost more
   * than the case is worth.
   */
  set(id: JsonRpcId, entry: PendingRequest): void {
    this.entries.set(keyOf(id), entry);
    // A Map iterates in insertion order, so the first key is always the oldest.
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_PENDING) break;
      this.entries.delete(key);
    }
  }

  /** The entry for `id`, removed: a response is answered exactly once. */
  take(id: JsonRpcId): PendingRequest | undefined {
    const key = keyOf(id);
    const entry = this.entries.get(key);
    if (entry !== undefined) this.entries.delete(key);
    return entry;
  }

  /** Drops an entry `notifications/cancelled` named; a no-op for an id that was never pending. */
  cancel(id: JsonRpcId): void {
    this.entries.delete(keyOf(id));
  }
}
