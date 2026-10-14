import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  DEFAULT_MAX_CHARS,
  loadBundledRules,
  scanContent,
  scanFieldsForTool,
  type CompiledRule,
} from '@stroq/core';
import { killChildTree } from './kill-child.js';

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const MAX_PROBE_PAGES = 20;
export const MAX_PROBE_TOOLS = 500;
export const MAX_PROBE_BYTES = 10 * 1024 * 1024; // 10 MiB
export const PROTOCOL_VERSION = '2025-06-18';

export interface McpToolRecord {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: unknown;
  readonly inputSchema?: unknown;
  readonly [key: string]: unknown;
}

export interface HandshakeOptions {
  readonly timeoutMs?: number | undefined;
  readonly maxPages?: number | undefined;
  readonly maxTools?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly rules?: readonly CompiledRule[] | undefined;
  readonly singlePage?: boolean | undefined;
}

export interface ToolScanMatch {
  readonly ruleId: string;
  readonly toolName: string;
}

export interface HandshakeResult {
  readonly tools: readonly McpToolRecord[];
  /** Names of tools whose content tripped a rule. */
  readonly flagged: readonly string[];
  readonly matches: readonly ToolScanMatch[];
  readonly error: string | null;
  readonly incompleteReason: string | null;
  readonly pages: number;
}

const INIT_ID = 1;
const line = (msg: unknown): string => `${JSON.stringify(msg)}\n`;

const INITIALIZE = line({
  jsonrpc: '2.0',
  id: INIT_ID,
  method: 'initialize',
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'stroq-mcp-probe', version: '1' },
  },
});

const INITIALIZED = line({ jsonrpc: '2.0', method: 'notifications/initialized' });

function listRequest(id: number, cursor?: string): string {
  return line({
    jsonrpc: '2.0',
    id,
    method: 'tools/list',
    params: typeof cursor === 'string' && cursor !== '' ? { cursor } : {},
  });
}

function toolText(tool: McpToolRecord): { text: string; unreadableMetadata: boolean } {
  const parts: string[] = [];
  let unreadableMetadata = false;
  if (typeof tool.name === 'string') parts.push(tool.name);
  if (typeof tool.title === 'string') parts.push(tool.title);
  if (typeof tool.description === 'string') parts.push(tool.description);
  for (const value of [tool.annotations, tool.inputSchema]) {
    if (value === undefined) continue;
    try {
      parts.push(JSON.stringify(value) ?? '');
    } catch {
      // A bounded JSON reply can still nest deeply enough to overflow JSON.stringify.
      // Keep the other fields, but disclose the metadata that could not be inspected.
      unreadableMetadata = true;
    }
  }
  return { text: parts.filter((part) => part !== '').join(' '), unreadableMetadata };
}

export function scanTools(
  tools: readonly McpToolRecord[],
  rules: readonly CompiledRule[],
): {
  readonly flagged: readonly string[];
  readonly matches: readonly ToolScanMatch[];
  readonly incompleteReason: string | null;
} {
  const flagged: string[] = [];
  const matches: ToolScanMatch[] = [];
  const incomplete = new Set<string>();
  for (const t of tools) {
    const { text, unreadableMetadata } = toolText(t);
    if (unreadableMetadata)
      incomplete.add('tool metadata could not be serialized; some fields were not scanned');
    if (text.length > DEFAULT_MAX_CHARS)
      incomplete.add(
        `tool metadata exceeded scan limit (${DEFAULT_MAX_CHARS} characters); only the metadata prefix was scanned`,
      );
    if (text === '') continue;
    const scan = scanContent(
      rules,
      text,
      { maxChars: DEFAULT_MAX_CHARS },
      {
        target: 'tool_description',
        ...scanFieldsForTool('mcp__probe__tools_list', text),
      },
    );
    const name = typeof t.name === 'string' ? t.name : '(unnamed)';
    if (scan.verdict === 'suspect') {
      flagged.push(name);
      for (const m of scan.matches) {
        matches.push({ ruleId: m.ruleId, toolName: name });
      }
    }
  }
  return {
    flagged,
    matches,
    incompleteReason: incomplete.size === 0 ? null : [...incomplete].join('; '),
  };
}

export function flaggedTools(
  tools: readonly McpToolRecord[],
  rules: readonly CompiledRule[],
): readonly string[] {
  return scanTools(tools, rules).flagged;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly error?: { readonly message?: unknown };
  readonly result?: {
    readonly tools?: readonly McpToolRecord[];
    readonly nextCursor?: unknown;
  };
}

export async function runMcpHandshake(
  child: Pick<ChildProcess, 'stdin' | 'stdout' | 'on' | 'kill' | 'pid'>,
  opts: HandshakeOptions = {},
): Promise<HandshakeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? MAX_PROBE_PAGES;
  const maxTools = opts.maxTools ?? MAX_PROBE_TOOLS;
  const maxBytes = opts.maxBytes ?? MAX_PROBE_BYTES;
  const rules = opts.rules ?? loadBundledRules();
  const singlePage = opts.singlePage ?? false;

  return new Promise((resolve) => {
    let listId = 2;
    let pendingListId: number | null = null;
    let buf = '';
    let totalBytes = 0;
    let pagesCount = 0;
    let done = false;
    let initialized = false;
    const decoder = new StringDecoder('utf8');
    const accumulatedTools: McpToolRecord[] = [];
    const seenCursors = new Set<string>();

    const finish = (result: { error: string | null; incompleteReason: string | null }): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        killChildTree(child as ChildProcess, 'SIGTERM');
      } catch {
        /* ignore */
      }
      const tools = accumulatedTools.slice(0, maxTools);
      const { flagged, matches, incompleteReason } = scanTools(tools, rules);
      const reasons = [result.incompleteReason, incompleteReason].filter(
        (reason): reason is string => reason !== null,
      );
      resolve({
        tools,
        flagged,
        matches,
        error: result.error,
        incompleteReason: reasons.length === 0 ? null : reasons.join('; '),
        pages: pagesCount,
      });
    };

    const timer = setTimeout(
      () =>
        finish({
          error: `no tools/list response within ${timeoutMs} ms`,
          incompleteReason: 'probe timed out',
        }),
      timeoutMs,
    );

    const write = (text: string): void => {
      if (done) return;
      try {
        child.stdin?.write(text);
      } catch {
        /* ignore */
      }
    };

    child.on('error', (err: Error) => finish({ error: err.message, incompleteReason: null }));
    child.stdin?.on('error', (err: Error) =>
      finish({ error: err.message, incompleteReason: 'probe stdin failed' }),
    );
    child.on('exit', (code) =>
      finish({
        error: `server exited before answering (code ${code ?? 'null'})`,
        incompleteReason: null,
      }),
    );

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const chunkBuf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      totalBytes += chunkBuf.length;
      if (totalBytes > maxBytes) {
        finish({
          error: `tools/list exceeded ${maxBytes} byte limit`,
          incompleteReason: `tools/list response exceeded ${maxBytes} byte limit`,
        });
        return;
      }

      buf += decoder.write(chunkBuf);
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const text = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (text.trim() === '') continue;

        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(text) as JsonRpcMessage;
        } catch {
          // Servers that log to stdout are common; a line we cannot parse is not an error.
          continue;
        }
        if (typeof msg !== 'object' || msg === null) {
          finish({ error: 'invalid JSON-RPC message', incompleteReason: 'protocol error' });
          return;
        }

        if (msg.id === INIT_ID) {
          if (initialized || msg.error || typeof msg.result !== 'object' || msg.result === null) {
            finish({ error: 'initialize failed or repeated', incompleteReason: 'protocol error' });
            return;
          }
          initialized = true;
          write(INITIALIZED);
          pendingListId = listId;
          write(listRequest(listId));
          continue;
        }

        const isListReply = initialized && pendingListId !== null && msg.id === pendingListId;

        if (isListReply) {
          if (msg.error) {
            const detail =
              typeof msg.error.message === 'string' ? msg.error.message : 'unknown error';
            finish({
              error: `tools/list failed: ${detail}`,
              incompleteReason: `tools/list failed: ${detail}`,
            });
            return;
          }

          const tools = msg.result?.tools;
          if (Array.isArray(tools)) {
            pagesCount += 1;
            for (const t of tools) {
              if (
                typeof t !== 'object' ||
                t === null ||
                typeof t.name !== 'string' ||
                t.name === ''
              ) {
                finish({
                  error: 'tools/list contains an invalid tool',
                  incompleteReason: 'protocol error',
                });
                return;
              }
              accumulatedTools.push(t);
            }

            if (accumulatedTools.length > maxTools) {
              finish({
                error: null,
                incompleteReason: `tools/list exceeded tool limit (${maxTools} tools)`,
              });
              return;
            }

            if (singlePage) {
              finish({ error: null, incompleteReason: null });
              return;
            }

            const nextCursor = msg.result?.nextCursor;
            const more = typeof nextCursor === 'string' && nextCursor !== '';
            if (nextCursor !== undefined && typeof nextCursor !== 'string') {
              finish({ error: 'invalid nextCursor', incompleteReason: 'protocol error' });
              return;
            }
            if (accumulatedTools.length === maxTools && more) {
              finish({
                error: null,
                incompleteReason: `tools/list exceeded tool limit (${maxTools} tools)`,
              });
              return;
            }

            if (pagesCount >= maxPages && more) {
              finish({
                error: null,
                incompleteReason: `tools/list exceeded page limit (${maxPages} pages)`,
              });
              return;
            }

            if (typeof nextCursor === 'string' && nextCursor !== '') {
              if (seenCursors.has(nextCursor)) {
                finish({
                  error: null,
                  incompleteReason: 'cyclic cursor in tools/list',
                });
                return;
              }
              seenCursors.add(nextCursor);
              listId += 1;
              pendingListId = listId;
              write(listRequest(listId, nextCursor));
              continue;
            }

            finish({ error: null, incompleteReason: null });
            return;
          }
          finish({
            error: 'tools/list result has no tools array',
            incompleteReason: 'protocol error',
          });
          return;
        }
      }
    });

    write(INITIALIZE);
  });
}
