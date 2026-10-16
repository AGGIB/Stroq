import { isRecord } from '../adapters/tool-input.js';
import { leafText, type MediaPayloads } from './strict-leaves.js';
import { STRICT_MAX_TEXT_CHARS } from './strict-limits.js';
import { isClassifiedMedia } from './strict-media.js';
import type { WithholdReason } from './strict-reasons.js';

/**
 * What strict mode reads of a server result, and what makes it refuse to deliver one.
 *
 * The default proxy scans the fields of a result it knows how to extract text from and
 * forwards the rest unread. Strict mode turns that around: a result is delivered only
 * if its shape is one Stroq understands (each method has an allowlist of the keys it
 * knows, and a key beyond it is content nobody scanned: withheld) and EVERY string in it
 * is part of the text that is scanned. That text is not the default scan's extraction:
 * it is the decoded strings of the whole result, keys included (`strict-leaves.ts`), so
 * no field is read in a form (JSON, with its escapes) different from the one the client
 * receives, and none is skipped because a sibling was read instead. The one thing left
 * out is the payload of a binary item that `strict-media.ts` classified as a picture or
 * a sound; the validators below record which, by identity.
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

/** The binary payloads this read classified as media: left out of the scan text, nothing else is. */
type Media = Map<object, string>;

/**
 * Checks one content item. Returns why the item is unacceptable, or null. A recognised
 * picture, sound or blob is recorded in `media`, so its payload is the one string of the
 * item that is not scanned.
 */
function readItem(item: unknown, media: Media): WithholdReason | null {
  if (!isRecord(item)) return 'invalid-shape';
  const type = item['type'];
  if (typeof type !== 'string') return 'invalid-shape';
  if (type === 'text') return typeof item['text'] === 'string' ? null : 'invalid-shape';
  if (type === 'image' || type === 'audio') {
    if (!isClassifiedMedia(item['mimeType'], item['data'])) return 'unread-content';
    media.set(item, 'data');
    return null;
  }
  if (type === 'resource_link')
    return ['uri', 'name', 'description'].every((key) => isOptionalString(item[key]))
      ? null
      : 'invalid-shape';
  if (type === 'resource') {
    const resource = item['resource'];
    if (!isRecord(resource)) return 'invalid-shape';
    if (!['uri', 'text'].every((key) => isOptionalString(resource[key]))) return 'invalid-shape';
    const blob = resource['blob'];
    if (blob === undefined) return null;
    if (!isClassifiedMedia(resource['mimeType'], blob)) return 'unread-content';
    media.set(resource, 'blob');
    return null;
  }
  return 'unread-content';
}

/** `readItem` over a list, which must be a list. */
function readItems(items: unknown, media: Media): WithholdReason | null {
  if (items === undefined) return null;
  if (!Array.isArray(items)) return 'invalid-shape';
  for (const item of items) {
    const reason = readItem(item, media);
    if (reason !== null) return reason;
  }
  return null;
}

/** The scan text of `value`, held to the scan window. */
function finish(value: unknown, media: MediaPayloads): StrictRead {
  const text = leafText(value, media);
  if (text === null) return withheld('scan-failed');
  return text.length > STRICT_MAX_TEXT_CHARS ? withheld('oversize-text') : { ok: true, text };
}

function readToolsCall(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, TOOLS_CALL_KEYS)) return withheld('unread-content');
  const isError = result['isError'];
  if (isError !== undefined && typeof isError !== 'boolean') return withheld('invalid-shape');
  if (!isOptionalString(result['resultType'])) return withheld('invalid-shape');
  const media: Media = new Map();
  const reason = readItems(result['content'], media);
  return reason === null ? finish(result, media) : withheld(reason);
}

function readTool(tool: unknown): WithholdReason | null {
  if (!isRecord(tool)) return 'invalid-shape';
  if (!hasOnly(tool, TOOL_KEYS)) return 'unread-content';
  if (typeof tool['name'] !== 'string') return 'invalid-shape';
  return ['title', 'description'].every((key) => isOptionalString(tool[key]))
    ? null
    : 'invalid-shape';
}

function readToolsList(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, TOOLS_LIST_KEYS)) return withheld('unread-content');
  const tools = result['tools'];
  if (!Array.isArray(tools) || !isOptionalString(result['nextCursor']))
    return withheld('invalid-shape');
  if (!isOptionalString(result['resultType'])) return withheld('invalid-shape');
  for (const tool of tools) {
    const reason = readTool(tool);
    if (reason !== null) return withheld(reason);
  }
  return finish(result, new Map());
}

function readContents(entry: unknown, media: Media): WithholdReason | null {
  if (!isRecord(entry)) return 'invalid-shape';
  if (!hasOnly(entry, CONTENTS_KEYS)) return 'unread-content';
  if (!['uri', 'text', 'name', 'description'].every((key) => isOptionalString(entry[key])))
    return 'invalid-shape';
  const blob = entry['blob'];
  if (blob === undefined) return null;
  if (!isClassifiedMedia(entry['mimeType'], blob)) return 'unread-content';
  media.set(entry, 'blob');
  return null;
}

function readResourcesRead(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, RESOURCES_READ_KEYS)) return withheld('unread-content');
  const contents = result['contents'];
  if (!Array.isArray(contents)) return withheld('invalid-shape');
  if (!isOptionalString(result['resultType'])) return withheld('invalid-shape');
  const media: Media = new Map();
  for (const entry of contents) {
    const reason = readContents(entry, media);
    if (reason !== null) return withheld(reason);
  }
  return finish(result, media);
}

function readMessage(message: unknown, media: Media): WithholdReason | null {
  if (!isRecord(message)) return 'invalid-shape';
  if (!hasOnly(message, MESSAGE_KEYS)) return 'unread-content';
  if (typeof message['role'] !== 'string') return 'invalid-shape';
  return readItem(message['content'], media);
}

function readPromptsGet(result: Record<string, unknown>): StrictRead {
  if (!hasOnly(result, PROMPTS_GET_KEYS)) return withheld('unread-content');
  const messages = result['messages'];
  if (!Array.isArray(messages) || !isOptionalString(result['description']))
    return withheld('invalid-shape');
  if (!isOptionalString(result['resultType'])) return withheld('invalid-shape');
  const media: Media = new Map();
  for (const message of messages) {
    const reason = readMessage(message, media);
    if (reason !== null) return withheld(reason);
  }
  return finish(result, media);
}

/**
 * Every other method (`initialize`, `ping`, the list methods, `completion/complete`…):
 * the whole result, which leaves no key and no string in it unread. An empty object (a
 * ping answer, a `logging/setLevel` acknowledgement) holds nothing to read.
 */
function readAnyResult(result: unknown): StrictRead {
  if (isRecord(result) && Object.keys(result).length === 0) return { ok: true, text: '' };
  return finish(result, new Map());
}

const READERS: ReadonlyMap<string, (result: Record<string, unknown>) => StrictRead> = new Map([
  ['tools/call', readToolsCall],
  ['tools/list', readToolsList],
  ['resources/read', readResourcesRead],
  ['prompts/get', readPromptsGet],
]);

/**
 * What a `result` is read as, or why it cannot be. Never throws: anything that goes
 * wrong while reading it is a result Stroq could not finish reading, `scan-failed`.
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
    return finish(error, new Map());
  } catch {
    return withheld('scan-failed');
  }
}
