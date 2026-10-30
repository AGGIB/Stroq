import { closed, member } from './local-guards';
import { unsafeCodePoint } from './shell';
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  closed(v, keys) && Object.keys(v).length === keys.length;
const string = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && unsafeCodePoint(v) === null;

/** JSON's own blanks between tokens: the raw review may hold these, and the screen never shows them. */
const JSON_BLANKS = [0x09, 0x0a, 0x0d];
/** The line breaks of the screen's own indentation; JSON writes one inside a value as `\n`. */
const LAYOUT = [0x0a];

/** Raw review text holds no control, bidi or invisible character, apart from JSON's own blanks. */
export const reviewTextSafe = (text: string): boolean =>
  unsafeCodePoint(text, JSON_BLANKS) === null;

/** The review exactly as the review screen shows it: the decoded JSON, written out with indentation. */
export function taskAccessReviewText(review: string): string {
  return JSON.stringify(JSON.parse(review), null, 2);
}

/**
 * The first character of the shown review that shows nothing or changes how the text around it
 * reads, as its code point; null when there is none, or when the review is not JSON at all (refused
 * as unreadable elsewhere). The shown text is checked, not the raw one: JSON writes a control in a
 * value back as a visible escape, and leaves a C1 control, a separator, a bidi, zero-width or tag
 * character as it is, including one the raw text spells as a JSON escape of six ASCII characters. A
 * signature after this screen then means a person saw every character of the call.
 */
export function hiddenReviewCharacter(review: string): number | null {
  let shown: string;
  try {
    shown = taskAccessReviewText(review);
  } catch {
    return null;
  }
  return unsafeCodePoint(shown, LAYOUT);
}

/** The refusal that names such a character by code point, as the server returns it. */
export const hiddenCharacterError = (code: number): `hidden-character-${string}` =>
  `hidden-character-${code.toString(16).padStart(4, '0')}`;

/** Whether `code` is that refusal for a character of the table, spelled as it makes it, and nothing else. */
export function isHiddenCharacterError(code: unknown): boolean {
  const match = typeof code === 'string' ? /^hidden-character-([0-9a-f]{4,6})$/.exec(code) : null;
  if (match === null) return false;
  const point = Number.parseInt(match[1]!, 16);
  return (
    point <= 0x10ffff &&
    hiddenCharacterError(point) === code &&
    unsafeCodePoint(String.fromCodePoint(point)) === point
  );
}
function path(v: unknown): v is { op: 'read' | 'write'; path: string; real?: string } {
  return (
    closed(v, ['path', 'real', 'op']) &&
    member(v.op, ['read', 'write']) &&
    string(v.path) &&
    (!Object.hasOwn(v, 'real') || string(v.real))
  );
}
/** Refuse ambiguous duplicate/escaped keys and prototype keys before reviewing any signed JSON. */
function uniqueKeys(text: string): boolean {
  const stack: { keys: Set<string> | null; next: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.keys && top.next) {
        const key = JSON.parse(text.slice(i, end + 1));
        if (['__proto__', 'constructor', 'prototype'].includes(key) || top.keys.has(key))
          return false;
        top.keys.add(key);
        top.next = false;
      }
      i = end;
    } else if (ch === '{' || ch === '[') {
      if (stack.length >= 32) return false;
      stack.push({ keys: ch === '{' ? new Set() : null, next: ch === '{' });
    } else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',' && stack.at(-1)?.keys) stack.at(-1)!.next = true;
  }
  return true;
}
export function validateTaskAccessReview(
  value: unknown,
  tool: string,
  kind: 'read-target' | 'whole-call',
): value is string {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).length > 65536 ||
    !value.length ||
    !reviewTextSafe(value)
  )
    return false;
  let v: unknown;
  try {
    v = JSON.parse(value);
    if (!uniqueKeys(value) || hiddenReviewCharacter(value) !== null) return false;
  } catch {
    return false;
  }
  const fields = ['v', 'tool', 'kind', 'input', 'cwd', 'resources'];
  if (
    !exact(v, kind === 'read-target' ? [...fields, 'target'] : fields) ||
    v.v !== 1 ||
    v.tool !== tool ||
    v.kind !== kind ||
    !closed(v.input, Object.keys(v.input ?? {})) ||
    !string(v.cwd)
  )
    return false;
  if (v.resources !== null) {
    const r = v.resources;
    if (
      !exact(r, ['paths', 'pathsComplete', 'urls', 'shell']) ||
      typeof r.pathsComplete !== 'boolean' ||
      typeof r.shell !== 'boolean' ||
      !Array.isArray(r.paths) ||
      r.paths.length > 1024 ||
      !r.paths.every(path) ||
      !Array.isArray(r.urls) ||
      r.urls.length > 1024 ||
      !r.urls.every(
        (u) =>
          closed(u, ['url', 'host', 'method']) &&
          string(u.url, 8192) &&
          string(u.host, 253) &&
          (!Object.hasOwn(u, 'method') || string(u.method, 32)),
      )
    )
      return false;
  }
  if (kind === 'whole-call') return true;
  if (tool !== 'Read' || !path(v.target) || v.target.op !== 'read' || v.resources === null)
    return false;
  const r = v.resources as { paths: { path: string; real?: string; op: string }[] };
  const target = v.target;
  return r.paths.some((p) => p.op === 'read' && p.path === target.path && p.real === target.real);
}
