import { isRecord } from '../adapters/tool-input.js';
import type { ScannedMethod } from './framing.js';

/**
 * The untrusted-text extraction half of `judge.ts`, split out only to keep both
 * files under the repo's line cap — `judge.ts` re-exports `MCP_MAX_RESULT_CHARS`,
 * `mcpResultText` and `resultTextFor` unchanged, so nothing outside this module
 * needs to know the split exists. Pure text shaping: no engine call, no I/O.
 */

/** The same bound `toolResultToText` clips a tool result to in the Claude Code adapter. */
export const MCP_MAX_RESULT_CHARS = 200_000;

const clip = (text: string): string => text.slice(0, MCP_MAX_RESULT_CHARS);

const stringAt = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  return typeof value === 'string' ? value : '';
};

const asJson = (value: unknown): string => JSON.stringify(value) ?? '';

/**
 * A `text` field's content, whatever shape the server put there. A hostile server
 * that writes an OBJECT or an array under `text` is still writing content a client
 * renders and the model reads, so "not a string" must not mean "scan nothing": the
 * value is read as its JSON instead. `undefined` and `null` carry no text and stay
 * empty. The whole extraction is clipped to `MCP_MAX_RESULT_CHARS` by `joined`, so
 * a large value here costs the same as a large string would.
 */
const textValue = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value === 'string') return value;
  return value === undefined || value === null ? '' : asJson(value);
};

/**
 * Every string in one content item the model would read. A bare string is its own
 * text — an undocumented shape, but one a client renders word for word, so a scanner
 * that skipped it would be a scanner a server opts out of by malforming its reply. A
 * text item gives its text; a `resource_link` gives its `uri`, `name` and
 * `description`; an embedded `resource` gives its own `text`, or its `uri` when the
 * body is a blob. `image` and `audio` items carry base64 `data` and a mime type and
 * contribute nothing — there is no instruction text in a JPEG's bytes, and scanning
 * megabytes of base64 on every call is the kind of cost that gets a proxy uninstalled.
 */
function contentItemText(item: unknown): string {
  if (typeof item === 'string') return item;
  if (!isRecord(item)) return '';
  const direct = textValue(item, 'text');
  if (direct !== '') return direct;
  const parts = [stringAt(item, 'uri'), stringAt(item, 'name'), stringAt(item, 'description')];
  const resource = item['resource'];
  if (isRecord(resource)) {
    const body = textValue(resource, 'text');
    parts.push(body !== '' ? body : stringAt(resource, 'uri'));
  }
  return parts.filter((part) => part !== '').join(' ');
}

/**
 * One item or an array of them, joined a line each. A bare-string `content` — the
 * whole field written as one string rather than a list — reaches `contentItemText`
 * through the non-array branch and is scanned as its own text.
 */
const itemsText = (value: unknown): string =>
  Array.isArray(value)
    ? value
        .map(contentItemText)
        .filter((text) => text !== '')
        .join('\n')
    : contentItemText(value);

const joined = (parts: readonly string[]): string =>
  clip(parts.filter((part) => part !== '').join('\n'));

/**
 * A `tools/call` result: every content item, `structuredContent` as JSON, and an
 * `input_required` reply's `inputRequests` — the modern shape by which a server asks
 * the model for more input, which is exactly where an injection would sit. `isError`
 * results are scanned too: a poisoned error text is still content the model reads.
 */
export function mcpResultText(result: unknown): string {
  if (!isRecord(result)) return '';
  const structured = result['structuredContent'];
  const inputRequests = result['inputRequests'];
  return joined([
    itemsText(result['content']),
    structured === undefined ? '' : asJson(structured),
    inputRequests === undefined ? '' : asJson(inputRequests),
  ]);
}

/**
 * A `tools/list` result: the name, title, description, annotations and input schema
 * of every tool. `inputSchema` is included as JSON text because a parameter's own
 * `description` inside it is exactly as model-visible, and exactly as much of a
 * rug-pull surface, as the tool's own top-level `description`.
 */
function toolsListText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result['tools'])) return '';
  return joined(
    result['tools'].map((tool) => {
      if (!isRecord(tool)) return '';
      const annotations = tool['annotations'];
      const inputSchema = tool['inputSchema'];
      return [
        stringAt(tool, 'name'),
        stringAt(tool, 'title'),
        stringAt(tool, 'description'),
        annotations === undefined ? '' : asJson(annotations),
        inputSchema === undefined ? '' : asJson(inputSchema),
      ]
        .filter((part) => part !== '')
        .join(' ');
    }),
  );
}

/** A `resources/read` result: the text of every entry it returned. */
function resourcesReadText(result: unknown): string {
  if (!isRecord(result)) return '';
  return joined([itemsText(result['contents'])]);
}

/** A `prompts/get` result: its description and the text of every message. */
function promptsGetText(result: unknown): string {
  if (!isRecord(result)) return '';
  const messages = Array.isArray(result['messages']) ? result['messages'] : [];
  return joined([
    stringAt(result, 'description'),
    ...messages.map((message) => (isRecord(message) ? itemsText(message['content']) : '')),
  ]);
}

export function resultTextFor(method: ScannedMethod, result: unknown): string {
  if (method === 'tools/list') return toolsListText(result);
  if (method === 'resources/read') return resourcesReadText(result);
  if (method === 'prompts/get') return promptsGetText(result);
  return mcpResultText(result);
}
