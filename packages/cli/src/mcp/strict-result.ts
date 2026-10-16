import { isRecord } from '../adapters/tool-input.js';
import { fullResultTextFor } from './mcp-result-text.js';
import { STRICT_MAX_TEXT_CHARS } from './strict-limits.js';
import { isClassifiedMedia } from './strict-media.js';
import type { WithholdReason } from './strict-reasons.js';

/**
 * What strict mode reads of a server result, and what makes it refuse to deliver one.
 *
 * The default proxy scans the fields of a result it knows how to extract text from and
 * forwards the rest unread. Strict mode turns that around: a result is delivered only
 * if EVERY part of it was either extracted as text for the scan or is a binary payload
 * that `strict-media.ts` could classify. So each method has an allowlist of the keys it
 * understands (an unknown key is content nobody scanned: withheld), each key that is
 * allowed is read (including the ones the default scan skips: `_meta`, `outputSchema`,
 * an item's `annotations`), and the text read is held to the scan window.
 *
 * The baseline text is the SAME extraction the default proxy scans (`mcp-result-text.ts`,
 * unclipped), so strict mode can only ever see more than the default scan does. What it
 * adds is appended after it.
 */

export type StrictRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: WithholdReason };

const withheld = (reason: WithholdReason): StrictRead => ({ ok: false, reason });

type Allowed = ReadonlySet<string>;
const hasOnly = (record: Record<string, unknown>, allowed: Allowed): boolean =>
  Object.keys(record).every((key) => allowed.has(key));
const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string';

const TOOLS_CALL_KEYS: Allowed = new Set([
  'content',
  'structuredContent',
  'isError',
  '_meta',
  'resultType',
  'inputRequests',
]);
const TOOLS_LIST_KEYS: Allowed = new Set(['tools', 'nextCursor', '_meta', 'resultType']);
const TOOL_KEYS: Allowed = new Set([
  'name',
  'title',
  'description',
  'inputSchema',
  'outputSchema',
  'annotations',
  '_meta',
  'icons',
  'execution',
]);
const RESOURCES_READ_KEYS: Allowed = new Set(['contents', '_meta', 'resultType']);
const CONTENTS_KEYS: Allowed = new Set([
  'uri',
  'mimeType',
  'text',
  'blob',
  '_meta',
  'name',
  'title',
  'description',
  'annotations',
  'size',
  'icons',
]);
const PROMPTS_GET_KEYS: Allowed = new Set(['description', 'messages', '_meta', 'resultType']);
const MESSAGE_KEYS: Allowed = new Set(['role', 'content']);
const ERROR_KEYS: Allowed = new Set(['code', 'message', 'data']);

/** The JSON of whatever `record` holds beyond `handled`, or nothing when it holds nothing else. */
function restOf(record: Record<string, unknown>, handled: readonly string[]): string {
  const rest = Object.entries(record).filter(([key]) => !handled.includes(key));
  return rest.length === 0 ? '' : (JSON.stringify(Object.fromEntries(rest)) ?? '');
}

/**
 * The JSON of everything in an item or a resource that the default scan may not have
 * read. Only a `text` that is a string is left out, because the baseline extraction
 * always includes that whole string; `payloadKey` is the binary payload (`data`,
 * `blob`) that was classified instead of read. Everything else, `uri`, `name`,
 * `mimeType` and every key nobody has heard of, is read as JSON: the baseline reads some
 * of those only when the item has no `text`, and a hostile server chooses which it has.
 */
function unreadOf(record: Record<string, unknown>, payloadKey?: string): string {
  const handled = ['type', ...(typeof record['text'] === 'string' ? ['text'] : [])];
  return restOf(record, payloadKey === undefined ? handled : [...handled, payloadKey]);
}

/**
 * Checks one content item and adds the JSON of its keys the default scan does not read
 * to `extras`. Returns why the item is unacceptable, or null.
 */
function readItem(item: unknown, extras: string[]): WithholdReason | null {
  if (!isRecord(item)) return 'invalid-shape';
  const type = item['type'];
  if (typeof type !== 'string') return 'invalid-shape';
  if (type === 'text') {
    if (typeof item['text'] !== 'string') return 'invalid-shape';
    extras.push(unreadOf(item));
    return null;
  }
  if (type === 'image' || type === 'audio') {
    if (!isClassifiedMedia(item['mimeType'], item['data'])) return 'unread-content';
    extras.push(unreadOf(item, 'data'));
    return null;
  }
  if (type === 'resource_link') {
    if (!['uri', 'name', 'description'].every((key) => isOptionalString(item[key])))
      return 'invalid-shape';
    extras.push(unreadOf(item));
    return null;
  }
  if (type === 'resource') {
    const resource = item['resource'];
    if (!isRecord(resource)) return 'invalid-shape';
    const blob = resource['blob'];
    if (!['uri', 'text'].every((key) => isOptionalString(resource[key]))) return 'invalid-shape';
    if (blob !== undefined && !isClassifiedMedia(resource['mimeType'], blob))
      return 'unread-content';
    extras.push(unreadOf(resource, 'blob'), restOf(item, ['type', 'resource']));
    return null;
  }
  return 'unread-content';
}

/** `readItem` over a list, which must be a list. */
function readItems(items: unknown, extras: string[]): WithholdReason | null {
  if (items === undefined) return null;
  if (!Array.isArray(items)) return 'invalid-shape';
  for (const item of items) {
    const reason = readItem(item, extras);
    if (reason !== null) return reason;
  }
  return null;
}

/** Joins the baseline text and the extras, and holds the whole to the scan window. */
function finish(baseline: string, extras: readonly string[]): StrictRead {
  const text = [baseline, ...extras].filter((part) => part !== '').join('\n');
  return text.length > STRICT_MAX_TEXT_CHARS ? withheld('oversize-text') : { ok: true, text };
}

/** The keys every scanned result may carry beside its own: `_meta` is read as JSON, `resultType` is a word. */
function readEnvelope(result: Record<string, unknown>, extras: string[]): WithholdReason | null {
  if (!isOptionalString(result['resultType'])) return 'invalid-shape';
  const meta = result['_meta'];
  if (meta !== undefined) extras.push(JSON.stringify(meta) ?? '');
  return null;
}

function readToolsCall(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, TOOLS_CALL_KEYS)) return withheld('unread-content');
  const isError = result['isError'];
  if (isError !== undefined && typeof isError !== 'boolean') return withheld('invalid-shape');
  const extras: string[] = [];
  const reason = readEnvelope(result, extras) ?? readItems(result['content'], extras);
  if (reason !== null) return withheld(reason);
  return finish(fullResultTextFor('tools/call', result), extras);
}

function readTool(tool: unknown, extras: string[]): WithholdReason | null {
  if (!isRecord(tool)) return 'invalid-shape';
  if (!hasOnly(tool, TOOL_KEYS)) return 'unread-content';
  if (typeof tool['name'] !== 'string') return 'invalid-shape';
  if (!['title', 'description'].every((key) => isOptionalString(tool[key]))) return 'invalid-shape';
  extras.push(restOf(tool, ['name', 'title', 'description', 'annotations', 'inputSchema']));
  return null;
}

function readToolsList(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, TOOLS_LIST_KEYS)) return withheld('unread-content');
  const tools = result['tools'];
  if (!Array.isArray(tools) || !isOptionalString(result['nextCursor']))
    return withheld('invalid-shape');
  const extras: string[] = [];
  const reason = readEnvelope(result, extras);
  if (reason !== null) return withheld(reason);
  for (const tool of tools) {
    const toolReason = readTool(tool, extras);
    if (toolReason !== null) return withheld(toolReason);
  }
  const cursor = result['nextCursor'];
  if (typeof cursor === 'string') extras.push(cursor);
  return finish(fullResultTextFor('tools/list', result), extras);
}

function readContents(entry: unknown, extras: string[]): WithholdReason | null {
  if (!isRecord(entry)) return 'invalid-shape';
  if (!hasOnly(entry, CONTENTS_KEYS)) return 'unread-content';
  if (!['uri', 'text', 'name', 'description'].every((key) => isOptionalString(entry[key])))
    return 'invalid-shape';
  const blob = entry['blob'];
  if (blob !== undefined && !isClassifiedMedia(entry['mimeType'], blob)) return 'unread-content';
  extras.push(unreadOf(entry, 'blob'));
  return null;
}

function readResourcesRead(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, RESOURCES_READ_KEYS)) return withheld('unread-content');
  const contents = result['contents'];
  if (!Array.isArray(contents)) return withheld('invalid-shape');
  const extras: string[] = [];
  const reason = readEnvelope(result, extras);
  if (reason !== null) return withheld(reason);
  for (const entry of contents) {
    const entryReason = readContents(entry, extras);
    if (entryReason !== null) return withheld(entryReason);
  }
  return finish(fullResultTextFor('resources/read', result), extras);
}

function readMessage(message: unknown, extras: string[]): WithholdReason | null {
  if (!isRecord(message)) return 'invalid-shape';
  if (!hasOnly(message, MESSAGE_KEYS)) return 'unread-content';
  if (typeof message['role'] !== 'string') return 'invalid-shape';
  return readItem(message['content'], extras);
}

function readPromptsGet(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, PROMPTS_GET_KEYS)) return withheld('unread-content');
  const messages = result['messages'];
  if (!Array.isArray(messages) || !isOptionalString(result['description']))
    return withheld('invalid-shape');
  const extras: string[] = [];
  const reason = readEnvelope(result, extras);
  if (reason !== null) return withheld(reason);
  for (const message of messages) {
    const messageReason = readMessage(message, extras);
    if (messageReason !== null) return withheld(messageReason);
  }
  return finish(fullResultTextFor('prompts/get', result), extras);
}

/**
 * Every other method (`initialize`, `ping`, the list methods, `completion/complete`…):
 * the whole result as JSON, which leaves no key and no string in it unread. An empty
 * object (a ping answer, a `logging/setLevel` acknowledgement) holds nothing to read.
 */
function readAnyResult(result: unknown): StrictRead {
  if (isRecord(result) && Object.keys(result).length === 0) return { ok: true, text: '' };
  return finish(JSON.stringify(result) ?? '', []);
}

const READERS: ReadonlyMap<string, (result: Record<string, unknown>) => StrictRead> = new Map([
  ['tools/call', readToolsCall],
  ['tools/list', readToolsList],
  ['resources/read', readResourcesRead],
  ['prompts/get', readPromptsGet],
]);

/**
 * What a `result` is read as, or why it cannot be. Never throws: anything that goes
 * wrong while reading it (a value that overflows the serialiser, say) is a result Stroq
 * could not finish reading, which is `scan-failed`.
 */
export function readStrictResult(method: string, result: unknown): StrictRead {
  try {
    const reader = READERS.get(method);
    if (reader === undefined) return readAnyResult(result);
    return isRecord(result) ? reader(result) : withheld('invalid-shape');
  } catch {
    return withheld('scan-failed');
  }
}

/** A JSON-RPC `error` object read the same way: its `message` and its `data` are text the client shows. */
export function readStrictError(error: unknown): StrictRead {
  try {
    if (!isRecord(error)) return withheld('invalid-shape');
    if (!hasOnly(error, ERROR_KEYS)) return withheld('unread-content');
    if (typeof error['code'] !== 'number' || typeof error['message'] !== 'string')
      return withheld('invalid-shape');
    const data = error['data'];
    return finish(error['message'], data === undefined ? [] : [JSON.stringify(data) ?? '']);
  } catch {
    return withheld('scan-failed');
  }
}
