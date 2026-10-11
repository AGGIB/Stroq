import { findLossyJson } from './json-lossy.js';
import { REPLACEMENT_CHARACTER } from './read.js';
import type { JsonObject, JsonValue, PlanRefusal } from './types.js';

/**
 * A JSON config as a document: what it means, how it is laid out, and whether it is a file this
 * engine will write back at all. Planning an edit and undoing one read a file the same way, so
 * both come through here.
 *
 * What the engine will not do is rewrite a file it cannot reproduce. JSON with comments or
 * trailing commas (JSONC) cannot be parsed back into the text it came from, so such a file is
 * REFUSED, never edited. So is plain JSON that loses something in the trip through an object (a
 * number a double cannot hold, a key that appears twice, number-like keys that would be
 * reordered): see `json-lossy.ts`. A file that is plain JSON but laid out in a way
 * `JSON.stringify` does not produce (minified, an escaped letter, a number written `1.0`) can be
 * edited, but only by laying it out again, and the caller is told so.
 */

const DEFAULT_INDENT = '  ';
/** The widest indent taken from a file; a file indented wider than this is laid out with the default. */
const MAX_SNIFFED_SPACES = 8;
const BYTE_ORDER_MARK = '\u{FEFF}';

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `Array.isArray` narrows a `readonly` array to `any[]`; this keeps the element type. */
export const isArray = (value: unknown): value is readonly JsonValue[] => Array.isArray(value);

export const isEmptyContainer = (value: JsonValue | undefined): boolean =>
  (isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0);

export const dotted = (path: readonly string[]): string => path.join('.');

/**
 * Whether two JSON values are the same value: objects whatever the order of their keys, arrays
 * in order, types strictly. Walked with a stack of its own, so that a value nested deeper than
 * the call stack is only slow.
 */
export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  const pending: [JsonValue, JsonValue][] = [[a, b]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [x, y] = pair;
    if (x === y) continue;
    if (isArray(x) || isArray(y)) {
      if (!isArray(x) || !isArray(y) || x.length !== y.length) return false;
      x.forEach((item, i) => pending.push([item, y[i] as JsonValue]));
    } else if (isObject(x) && isObject(y)) {
      const keys = Object.keys(x);
      if (keys.length !== Object.keys(y).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(y, key)) return false;
        pending.push([x[key] as JsonValue, y[key] as JsonValue]);
      }
    } else {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// JSONC: the two things JSONC has that JSON has not.

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const SLASH = 0x2f;
const STAR = 0x2a;
const COMMA = 0x2c;
const RIGHT_BRACE = 0x7d;
const RIGHT_BRACKET = 0x5d;

const isJsonSpace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * Whether `text` uses a comment or a trailing comma.
 *
 * A tokenizer that knows where a string starts and ends, and not a pattern over the whole file:
 * `"https://example.invalid"` holds `//` and `"a,]"` holds a comma and a bracket, and neither is
 * what it looks like. One pass, no backtracking: the work is linear in the length of the text.
 */
export function findJsoncSyntax(text: string): 'comment' | 'trailing-comma' | null {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === BACKSLASH) i += 1;
      else if (code === QUOTE) inString = false;
    } else if (code === QUOTE) {
      inString = true;
    } else if (code === SLASH) {
      const next = text.charCodeAt(i + 1);
      if (next === SLASH || next === STAR) return 'comment';
    } else if (code === COMMA) {
      let j = i + 1;
      while (j < text.length && isJsonSpace(text.charCodeAt(j))) j += 1;
      const after = text.charCodeAt(j);
      if (after === RIGHT_BRACE || after === RIGHT_BRACKET) return 'trailing-comma';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Layout.

/** How a file is laid out, so that what is written back looks like what was there. */
export interface Layout {
  readonly indent: string;
  readonly eol: '\n' | '\r\n';
  readonly finalNewline: boolean;
  readonly bom: boolean;
}

export const DEFAULT_LAYOUT: Layout = {
  indent: DEFAULT_INDENT,
  eol: '\n',
  finalNewline: true,
  bom: false,
};

/**
 * The indent of the first indented line: a tab, or the spaces it starts with. That line is
 * always one level deep in a file `JSON.stringify` wrote, so its indent is the unit.
 */
function sniffIndent(body: string): string {
  for (let at = body.indexOf('\n'); at !== -1; at = body.indexOf('\n', at + 1)) {
    let end = at + 1;
    while (body[end] === ' ' || body[end] === '\t') end += 1;
    const next = body[end];
    if (end === at + 1 || next === undefined || next === '\n' || next === '\r') continue;
    const lead = body.slice(at + 1, end);
    if (lead.startsWith('\t')) return '\t';
    return lead.length <= MAX_SNIFFED_SPACES && !lead.includes('\t') ? lead : DEFAULT_INDENT;
  }
  return DEFAULT_INDENT;
}

function sniffLayout(body: string, bom: boolean): Layout {
  return {
    indent: sniffIndent(body),
    eol: body.includes('\r\n') ? '\r\n' : '\n',
    finalNewline: body.endsWith('\n'),
    bom,
  };
}

/** Throws (a `RangeError`) for a document nested deeper than `JSON.stringify` can walk. */
export function serializeJson(doc: JsonObject, layout: Layout): string {
  const pretty = JSON.stringify(doc, null, layout.indent);
  const lines = layout.eol === '\n' ? pretty : pretty.replace(/\n/g, layout.eol);
  return `${layout.bom ? BYTE_ORDER_MARK : ''}${lines}${layout.finalNewline ? layout.eol : ''}`;
}

export type Parsed =
  | {
      readonly ok: true;
      readonly doc: JsonObject;
      readonly layout: Layout;
      /** Whether writing `doc` back with `layout` gives `text` again. */
      readonly roundTrips: boolean;
    }
  | { readonly ok: false; readonly refused: PlanRefusal; readonly detail: string };

const refuse = (refused: PlanRefusal, detail: string): Parsed => ({ ok: false, refused, detail });

/** Whether `body` has nothing in it but the white space JSON allows. */
const isBlank = (body: string): boolean => /^[ \t\r\n]*$/.test(body);

/**
 * Reads `text` as a JSON object and works out how to write it back. A detail names the problem
 * and never quotes the file, whose first lines can be anything a link points at.
 */
export function parseJsonDocument(text: string): Parsed {
  if (text.includes(REPLACEMENT_CHARACTER)) {
    return refuse('not-utf8', 'the file is not valid UTF-8, so it cannot be rewritten as it was');
  }
  const bom = text.startsWith(BYTE_ORDER_MARK);
  const body = bom ? text.slice(1) : text;
  if (isBlank(body)) {
    return { ok: true, doc: {}, layout: { ...DEFAULT_LAYOUT, bom }, roundTrips: true };
  }
  if (findJsoncSyntax(body) !== null) {
    return refuse(
      'jsonc',
      'the file has comments or a trailing comma, which Stroq will not rewrite; add the entries by hand',
    );
  }
  try {
    const value: unknown = JSON.parse(body);
    if (!isObject(value)) return refuse('not-object', 'the top level of the file is not an object');
    const lossy = findLossyJson(body);
    if (lossy !== null) return refuse('lossy-json', lossy);
    const layout = sniffLayout(body, bom);
    return { ok: true, doc: value, layout, roundTrips: serializeJson(value, layout) === text };
  } catch {
    // A syntax error, or a document nested deeper than the parser or `JSON.stringify` can walk.
    return refuse('invalid-json', 'the file is not valid JSON, or is nested too deeply to rewrite');
  }
}

// ---------------------------------------------------------------------------------------------
// Paths through a document. Nothing here changes its argument: every change returns a new object.

/** The value at `path`, following own keys only, or `undefined` when the way is not there. */
export function getAt(doc: JsonObject, path: readonly string[]): JsonValue | undefined {
  let node: JsonValue = doc;
  for (const key of path) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined;
    node = node[key] as JsonValue;
  }
  return node;
}

/**
 * `node` with `value` at `path`, making the objects on the way. Keys are written with computed
 * names in object literals, which define a property: a key called `__proto__` is a key.
 */
export function setAt(node: JsonObject, path: readonly string[], value: JsonValue): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) return node;
  if (rest.length === 0) return { ...node, [head]: value };
  const child = Object.hasOwn(node, head) ? node[head] : undefined;
  return { ...node, [head]: setAt(isObject(child) ? child : {}, rest, value) };
}

/** `node` without the key at `path`. */
export function removeAt(node: JsonObject, path: readonly string[]): JsonObject {
  const [head, ...rest] = path;
  if (head === undefined) return node;
  if (rest.length === 0) {
    return Object.fromEntries(Object.entries(node).filter(([key]) => key !== head));
  }
  const child = Object.hasOwn(node, head) ? node[head] : undefined;
  return isObject(child) ? { ...node, [head]: removeAt(child, rest) } : node;
}
