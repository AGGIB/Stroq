// A call to a tool that is no shell, no write and no local tool (a browser tool, `web__run`, an MCP
// tool, one Stroq does not know), read as a request when its input holds the key and an address.
//
// The address may be in the field that holds the key, or in another one: `{url, headers: {…key}}`
// sends the key to the url's host as surely as a key glued into the url does. So every field that
// is an address, and every address in a text that holds the key, is a host the key went to. That is
// another company unless the strict proof of the key's own use holds for the call, read the way
// `strict-own.ts` reads a shell command. The input has no field but `url`, `method` (GET or HEAD)
// and `headers`, spelled exactly so; each header is one of the key's auth headers or `Accept`,
// `Accept-Encoding`, `User-Agent` or `Content-Type`, its name a token, named once, with no line
// break or NUL in its name or value; `url` is the one address in the whole input, at an exact host of the key's own
// service that holds no piece of the key; the key is only in `headers.<auth header>`, in a
// `headers` string written as an auth header, or in the query parameter its service documents; and
// no name on the path to any field says it routes the request (`proxy`, `agent`, `dispatcher`,
// `connect`, `resolve`). A header written in a body, content, data or files never counts. A call
// whose every address is this machine may have been sent on by a program here: maybe.
import { commandUrls } from '@stroq/core';
import { valueHolds } from './key-text.js';
import { authHeaderNames, isOwnHost } from './own-service.js';
import { holdsPiece, isLoopback, type KeyOf, type Place } from './place.js';
import { authHeader, HEADER_NAME, SMUGGLES, strictHost, withoutAuthQuery } from './strict-own.js';

/**
 * One string of a tool's input, and where it is: the first and last names on its path, how many
 * names the path has, whether it goes through a list, and whether a name on it routes a request.
 * A field's own name is a string too (`name`), at the path of its field.
 */
interface Field {
  readonly value: string;
  readonly top: string;
  readonly last: string;
  readonly depth: number;
  readonly inList: boolean;
  readonly routes: boolean;
  readonly name: boolean;
}

/** A field that is an address: its text starts with a scheme a request is made with. */
const ADDRESS = /^\s*(?:https?|wss?):\/\//i;
/** Addresses read from one text, at most; past it, an address was not read. */
const MAX_URLS = 64;
/** Words that, in a name on a field's path, say it may send the request somewhere else. */
const ROUTE_NAMES: readonly string[] = ['proxy', 'agent', 'dispatcher', 'connect', 'resolve'];
/** The only fields an input the proof holds for may have. */
const SAFE_FIELDS: ReadonlySet<string> = new Set(['url', 'method', 'headers']);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
/**
 * Headers a request plainly carries beside the key's auth headers. Any other (`Host`,
 * `X-Forwarded-*`, `Forwarded`, `X-Original-URL`, a method override, `:authority`, one Stroq does
 * not know) may send or read the request otherwise than its address says.
 */
const PLAIN_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'accept-encoding',
  'user-agent',
  'content-type',
]);

type Where = Omit<Field, 'value' | 'name'>;
const ROOT: Where = { top: '', last: '', depth: 0, inList: false, routes: false };

/** Where a field one name below `at` is. */
const below = (at: Where, name: string): Where => {
  const lower = name.toLowerCase();
  return {
    top: at.depth === 0 ? lower : at.top,
    last: lower,
    depth: at.depth + 1,
    inList: at.inList,
    // `User-Agent` names the program, not where the request goes.
    routes:
      at.routes || (lower !== 'user-agent' && ROUTE_NAMES.some((word) => lower.includes(word))),
  };
};

/**
 * Every string of an input with where it is, and every field's own name: walked with a stack of
 * its own, so a deep input does not overflow it.
 */
function fieldsOf(input: Readonly<Record<string, unknown>>): Field[] {
  const out: Field[] = [];
  const pending: { readonly at: Where; readonly value: unknown }[] = [{ at: ROOT, value: input }];
  while (pending.length > 0) {
    const { at, value } = pending.pop() as { readonly at: Where; readonly value: unknown };
    if (typeof value === 'string') out.push({ ...at, value, name: false });
    else if (Array.isArray(value))
      for (let i = value.length - 1; i >= 0; i -= 1)
        pending.push({ at: { ...at, inList: true }, value: value[i] });
    else if (value !== null && typeof value === 'object')
      for (const [name, inner] of Object.entries(value as Record<string, unknown>).reverse()) {
        const next = below(at, name);
        out.push({ ...next, value: name, name: true });
        pending.push({ at: next, value: inner });
      }
  }
  return out;
}

/** The hosts of the addresses in some texts, and whether one could not be read or was past the bound. */
function hostsIn(texts: readonly string[]): { hosts: string[]; unread: boolean } {
  const hosts: string[] = [];
  let unread = false;
  for (const text of texts) {
    const read = commandUrls(text, MAX_URLS);
    if (read.capped) unread = true;
    for (const url of read.urls) {
      if (url.host === '') unread = true;
      else hosts.push(url.host.toLowerCase());
    }
  }
  return { hosts, unread };
}

/** Whether a header's name, read exactly, is a token and one of the key's auth headers or a plain one. */
function knownHeader(name: string, key: KeyOf): boolean {
  const lower = name.toLowerCase();
  return (
    HEADER_NAME.test(name) && (authHeaderNames(key).includes(lower) || PLAIN_HEADERS.has(lower))
  );
}

/**
 * Whether `headers` is one header written out, or fields of written values: each name a known one,
 * no name twice however it is spelled, and no line break or NUL in a name or a value.
 */
function plainHeaders(headers: unknown, key: KeyOf): boolean {
  if (headers === undefined) return true;
  if (typeof headers === 'string') {
    const colon = headers.indexOf(':');
    return !SMUGGLES.test(headers) && colon > 0 && knownHeader(headers.slice(0, colon), key);
  }
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return false;
  const entries = Object.entries(headers as Record<string, unknown>);
  const names = new Set(entries.map(([name]) => name.toLowerCase()));
  return (
    names.size === entries.length &&
    entries.every(
      ([name, value]) =>
        knownHeader(name, key) && typeof value === 'string' && !SMUGGLES.test(value),
    )
  );
}

/**
 * Whether the input has no field but `url`, `method` (GET or HEAD) and `headers`, each spelled
 * exactly so: a second spelling of a field could carry another value.
 */
function safeShape(input: Readonly<Record<string, unknown>>, key: KeyOf): boolean {
  if (!Object.keys(input).every((name) => SAFE_FIELDS.has(name))) return false;
  const method = input['method'];
  if (
    method !== undefined &&
    !(typeof method === 'string' && SAFE_METHODS.has(method.toUpperCase()))
  )
    return false;
  return plainHeaders(input['headers'], key);
}

/** The host the strict proof of the key's own use holds for, in a tool's input, or null. */
function strictOwnField(
  input: Readonly<Record<string, unknown>>,
  fields: readonly Field[],
  key: KeyOf,
): string | null {
  if (!safeShape(input, key) || fields.some((f) => f.routes)) return null;
  const holds = valueHolds(key);
  // The key in a field's own name is in no header.
  if (fields.some((f) => f.name && holds(f.value))) return null;
  const strings = fields.filter((f) => !f.name);
  const url = strings.find((f) => f.depth === 1 && f.top === 'url' && !f.inList);
  // One address in the whole input, and it is the whole text of `url`.
  const all = hostsIn(strings.map((f) => f.value));
  if (url === undefined || !ADDRESS.test(url.value) || all.unread || all.hosts.length !== 1)
    return null;
  const address = url.value.trim();
  const host = strictHost(address);
  if (host === null || !isOwnHost(key, host) || holdsPiece(host, key)) return null;
  if (holds(withoutAuthQuery(address, key))) return null;
  const names = authHeaderNames(key);
  const inHeader = (f: Field): boolean =>
    f.top === 'headers' &&
    !f.inList &&
    ((f.depth === 2 && names.includes(f.last)) ||
      (f.depth === 1 && authHeader(f.value, key, holds)));
  return strings.every((f) => f === url || !holds(f.value) || inHeader(f)) ? host : null;
}

/**
 * Where a tool call put a key its input holds, read as a request: null when the input holds no
 * address, so the call is no request Stroq can read.
 */
export function toolRequestPlace(
  input: Readonly<Record<string, unknown>>,
  key: KeyOf,
  base: Omit<Place, 'tier' | 'host' | 'local'>,
): Place | null {
  const holds = valueHolds(key);
  const fields = fieldsOf(input);
  const holding = fields.filter((f) => holds(f.value));
  if (holding.length === 0) return null;
  const inFields = hostsIn(fields.filter((f) => ADDRESS.test(f.value)).map((f) => f.value));
  const inText = hostsIn(holding.map((f) => f.value));
  const hosts = [...new Set([...inFields.hosts, ...inText.hosts])];
  const unread = inFields.unread || inText.unread;
  if (hosts.length === 0 && !unread) return null;
  const own = unread ? null : strictOwnField(input, fields, key);
  if (own !== null) return { ...base, tier: 'own_service', host: own };
  if (!unread && hosts.every(isLoopback))
    return { ...base, tier: 'maybe', host: hosts[0] as string, local: true };
  const host =
    hosts.find((h) => !isLoopback(h) && !isOwnHost(key, h)) ?? hosts.find((h) => !isLoopback(h));
  return { ...base, tier: 'third_party', ...(host === undefined ? {} : { host }) };
}
