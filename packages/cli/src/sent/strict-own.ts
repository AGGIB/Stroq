// The one proof that a shell command used a key with its own service and sent it nowhere else.
//
// Every other request in a shell command is another company's: this proof is the only way a
// shell call reaches "used with its own service", so it asks for everything to be plain. No `$`,
// no backtick, no process substitution, no heredoc: nothing the shell fills in. One text the core
// cuts, and in it exactly one request program, written as its bare name with no wrapper, no
// variable set for it and nothing set before it. Every other stage only reads or prints. No word
// in the command can route a request elsewhere (`routesElsewhere`), and every address in it is the
// one the request goes to. That address starts its word with `https://` or `http://`, has no user
// and no password, and its host is an exact host of the key's own service that holds no piece of
// the key. For curl, only `-s`, `-S`, `-f`, `--fail`, `-X` with a method, `-o /dev/null`, and `-H`
// with an auth header that holds the key; for any other request program, no option at all. The key
// is only in an auth header, or in the one query parameter its service documents for it. Any
// redirect other than to `/dev/null` or a copy of a standard stream fails it. Each check is one
// pass over a word or the command: nothing backtracks.
import { commandUrls, REDIRECT, type Word } from '@stroq/core';
import { plainText, valueHolds } from './key-text.js';
import { authHeaderNames, authQueryParam, isOwnHost } from './own-service.js';
import { holdsPiece, type KeyOf } from './place.js';
import type { CommandReading, StageFacts } from './shell-read.js';
import { routesElsewhere, stageSends } from './shell-route.js';

/** Programs whose request this proof can read: they take the address as a word. */
const REQUEST_PROGRAMS: ReadonlySet<string> = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'xhs',
  'httpie',
  'curlie',
]);
const METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
/** `-s`, `-S`, `-f` and clusters of them only. */
const QUIET_FLAGS = /^-[sSf]+$/;
/** Builtins that set a variable: none may stand in a command this proof holds for. */
const SETTERS: ReadonlySet<string> = new Set([
  'export',
  'declare',
  'typeset',
  'local',
  'readonly',
  'set',
  'env',
  'unset',
  'alias',
]);
/** What the shell fills in or feeds: `$`, a backtick, a process substitution, a heredoc. */
const SHELL_FILLS = /[$`]|<\(|>\(|<</;
/** A redirect a request may have: its output or errors to `/dev/null`, or a standard stream copied. */
const QUIET_REDIRECT = /^[12&]?>{1,2}(?:\/dev\/null|&[12])$/;

/** A request's addresses, and the words that carried an auth header that holds the key. */
interface Request {
  readonly urls: readonly string[];
  readonly carriers: ReadonlySet<string>;
}

/** A header's name as HTTP defines one: a token, with no blank, colon or line break in it. */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A line break or a NUL in a header: it can carry a second header (a proxy, a `Host`). */
export const SMUGGLES = /[\r\n\0]/;

/**
 * Whether a header is one the key's service reads a key from, and holds the key: its name, read
 * exactly, is a token and one of the service's auth headers, and nothing in it can start a second
 * header.
 */
export function authHeader(value: string, key: KeyOf, holds: (t: string) => boolean): boolean {
  if (SMUGGLES.test(value)) return false;
  const colon = value.indexOf(':');
  if (colon <= 0) return false;
  const name = value.slice(0, colon);
  return (
    HEADER_NAME.test(name) && authHeaderNames(key).includes(name.toLowerCase()) && holds(value)
  );
}

/** The words of a curl stage, read by the short list: null when any word is not on it. */
function curlRequest(
  words: readonly string[],
  key: KeyOf,
  holds: (t: string) => boolean,
): Request | null {
  const urls: string[] = [];
  const carriers = new Set<string>();
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string;
    const alone = w.length === 2;
    const next = words[i + 1] ?? '';
    if (w.startsWith('-H')) {
      const value = alone ? next : w.slice(2);
      if (!authHeader(value, key, holds)) return null;
      carriers.add(alone ? next : w);
      if (alone) i += 1;
    } else if (w.startsWith('-X')) {
      if (!METHODS.has(alone ? next : w.slice(2))) return null;
      if (alone) i += 1;
    } else if (w.startsWith('-o')) {
      if ((alone ? next : w.slice(2)) !== '/dev/null') return null;
      if (alone) i += 1;
    } else if (w === '--fail' || QUIET_FLAGS.test(w)) continue;
    else if (w.startsWith('-')) return null;
    else urls.push(w);
  }
  return { urls, carriers };
}

/** The words of a stage as the program is handed them; null when a redirect is not a quiet one. */
function stageWords(args: readonly Word[]): string[] | null {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (word.expands) return null;
    if (!word.redirect) {
      words.push(word.value);
      continue;
    }
    // An operator alone (`>`, `2>`) takes the next word as its file.
    const alone = REDIRECT.exec(word.value)?.[0].length === word.value.length;
    const whole = alone ? `${word.value}${args[i + 1]?.value ?? ''}` : word.value;
    if (alone) i += 1;
    if (!QUIET_REDIRECT.test(whole)) return null;
  }
  return words;
}

/** The host of an address that starts its word, read strictly: no user, no escape, a plain host. */
export function strictHost(url: string): string | null {
  const scheme = /^https?:\/\//.exec(url);
  if (scheme === null) return null;
  const from = scheme[0].length;
  let end = url.length;
  for (let i = from; i < url.length; i += 1)
    if ('/?#'.includes(url[i] as string)) {
      end = i;
      break;
    }
  const match = /^([a-z0-9.-]{1,253})(?::[0-9]{1,5})?$/.exec(url.slice(from, end));
  return match === null ? null : (match[1] as string);
}

/** An address with the value of the key's documented query parameter taken out. */
export function withoutAuthQuery(url: string, key: KeyOf): string {
  const param = authQueryParam(key);
  const query = url.indexOf('?');
  if (param === null || query < 0) return url;
  const hash = url.indexOf('#', query);
  const end = hash < 0 ? url.length : hash;
  const kept = url
    .slice(query + 1, end)
    .split('&')
    .map((pair) => (pair.startsWith(`${param}=`) ? `${param}=` : pair));
  return `${url.slice(0, query)}?${kept.join('&')}${url.slice(end)}`;
}

/** Whether a stage is the one request this proof can read: bare, unwrapped, nothing set for it. */
function plainRequest(facts: StageFacts, text: string): boolean {
  const found = facts.resolved;
  return (
    found !== null &&
    REQUEST_PROGRAMS.has(facts.name) &&
    found.word === facts.name &&
    found.wrappers.length === 0 &&
    found.assigned !== true &&
    !found.deep &&
    found.searchChanged !== true &&
    text.trimStart().startsWith(facts.name)
  );
}

/** A stage's text as the shell joins it, its blanks run together: two cuts of one stage agree. */
const sameStage = (text: string): string => plainText(text).replace(/\s+/g, ' ').trim();

/** The one request stage of a command whose other stages only read, or null. */
function onlyRequest(reading: CommandReading, holds: (t: string) => boolean): StageFacts | null {
  // One text, cut for sure: nothing nested (`bash -c`, a function), no shell output redirected.
  if (reading.run.length !== 1 || reading.execSink) return null;
  let request: { readonly facts: StageFacts; readonly text: string } | null = null;
  for (const stage of (reading.run[0] ?? []).flat()) {
    if (stage.body !== '') return null;
    const facts = reading.facts(stage);
    if (stageSends(facts)) {
      if (request !== null || !plainRequest(facts, stage.text)) return null;
      request = { facts, text: sameStage(stage.text) };
      continue;
    }
    // Every other stage only reads or prints, sets nothing, and does not hold the key.
    if (!facts.inert || facts.name === '' || SETTERS.has(facts.name)) return null;
    if (facts.resolved?.assigned === true || holds(stage.text)) return null;
  }
  if (request === null) return null;
  // The plain cut, read for sends, finds no other request: each it finds is this one, cut again.
  const want = request.text;
  const plain = reading.plain.flat().filter((stage) => stageSends(reading.facts(stage)));
  return plain.every((stage) => sameStage(stage.text) === want) ? request.facts : null;
}

/**
 * The host a shell command used `key` with, when the strict proof of the key's own use holds for
 * it; null when it does not, and the command, if it can send, sent it to another company.
 */
export function strictOwnHost(reading: CommandReading, key: KeyOf): string | null {
  const command = reading.command;
  if (SHELL_FILLS.test(command) || routesElsewhere(command)) return null;
  const holds = valueHolds(key);
  const request = onlyRequest(reading, holds);
  if (request === null) return null;
  const words = stageWords(request.resolved?.args ?? []);
  if (words === null) return null;
  const read: Request | null =
    request.name === 'curl'
      ? curlRequest(words, key, holds)
      : words.some((w) => w.startsWith('-'))
        ? null
        : { urls: words, carriers: new Set() };
  if (read === null || read.urls.length !== 1) return null;
  const url = read.urls[0] as string;
  const host = strictHost(url);
  if (host === null || !isOwnHost(key, host) || holdsPiece(host, key)) return null;
  // Every address the command names is that one, read by the core's reader too.
  const named = commandUrls(command, 64);
  if (named.capped || named.urls.some((u) => u.host.toLowerCase() !== host)) return null;
  // The key only in an auth header, or in the query parameter its service documents.
  if (holds(withoutAuthQuery(url, key))) return null;
  const rest = words.filter((w) => w !== url && !read.carriers.has(w));
  return rest.some(holds) ? null : host;
}
