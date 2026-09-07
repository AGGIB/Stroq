import { isRecord } from '../adapters/tool-input.js';

/**
 * The wire layer of the MCP proxy: turning two byte streams into lines without
 * losing a byte, deciding what kind of JSON-RPC message a line carries, and
 * remembering which request ids are still waiting for a result worth scanning.
 * Nothing here talks to the engine — see `judge.ts` — and nothing here ever rewrites
 * a line: `SplitLine.text` is the exact text that arrived, and `SplitLine.eol` is the
 * exact terminator that followed it, so forwarding is `text + eol` and nothing else.
 */

/**
 * The largest SERVER line the proxy will hand to `JSON.parse`. A message past this
 * is forwarded to the client unparsed and logged: a hostile server that emits one
 * enormous line would otherwise stall the proxy inside the parser and take the
 * client's session with it. Client lines are always parsed however large they are —
 * a `tools/call` is the thing Stroq exists to judge, and declining to judge a big one
 * is exactly the bypass. This bounds the PARSE, not the buffer: framing has to
 * accumulate a line either way. Measured in decoded UTF-16 code units, which is bytes
 * for the ASCII JSON these streams carry.
 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** One line as it arrived. */
export interface SplitLine {
  /** The line without its terminator, byte for byte as it was decoded. */
  readonly text: string;
  /** `'\n'` for a terminated line, `''` for the final unterminated remainder. */
  readonly eol: '\n' | '';
  /** True when this line's own length is past `MAX_LINE_CHARS`. */
  readonly oversize: boolean;
}

export interface LineSplitter {
  /** Every line this chunk completed, in arrival order. */
  push(chunk: string): readonly SplitLine[];
  /** The unterminated remainder at end of stream, or `[]` when there is none. */
  flush(): readonly SplitLine[];
}

/**
 * Both streams are read with `setEncoding('utf8')`, so chunks arrive already decoded
 * and a multi-byte character straddling a chunk boundary is never split in half here.
 */
export function createLineSplitter(): LineSplitter {
  let buffer = '';
  return {
    push(chunk: string): readonly SplitLine[] {
      buffer += chunk;
      const lines: SplitLine[] = [];
      let start = 0;
      for (;;) {
        const nl = buffer.indexOf('\n', start);
        if (nl === -1) break;
        const text = buffer.slice(start, nl);
        lines.push({ text, eol: '\n', oversize: text.length > MAX_LINE_CHARS });
        start = nl + 1;
      }
      buffer = buffer.slice(start);
      return lines;
    },
    flush(): readonly SplitLine[] {
      if (buffer === '') return [];
      const line: SplitLine = { text: buffer, eol: '', oversize: buffer.length > MAX_LINE_CHARS };
      buffer = '';
      return [line];
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
